import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createArtifactViewer, createArtifactTools } from '../artifacts/index.js';
import { createHumanArtifactTools } from '../artifacts/human.js';
import { describeReviewTools } from '../tools/runner.js';
import type { MonitorStoredRequest } from './store.js';
import { readStoredArtifactScope } from '../requester/index.js';
import { reopenWorkspace } from '../workspaces/index.js';
import { createMonitorStore } from './store.js';
import { inspectProject } from '../project/index.js';
import { MonitorActionError, authorizeWorkspace, claimReview, completeReview, executeReviewTool } from './actions.js';
import { activeTryClaim } from '../broker/human-claims.js';
import type { MonitorArtifactPage, MonitorDetail, MonitorFilter, MonitorLane, MonitorSession, MonitorSources } from './types.js';

const ARTIFACT_BUDGET_MS = 10_000;
const MAX_ARTIFACT_READS = 2;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
class HttpError extends MonitorActionError {}

function parameters(url: URL, allowed: readonly string[]): void {
  for (const name of url.searchParams.keys()) {
    if (!allowed.includes(name) || url.searchParams.getAll(name).length !== 1) throw new HttpError(400, 'Unknown or duplicate query parameter.');
  }
}
function number(value: string | null, fallback: number, minimum: number, maximum: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new HttpError(400, `The query range must be an integer between ${minimum} and ${maximum}.`);
  return parsed;
}
function id(value: string, maximumLength = 128): string {
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { throw new HttpError(400, 'Invalid identifier.'); }
  if (decoded.length > maximumLength || !identifier.test(decoded)) throw new HttpError(400, 'Invalid identifier.');
  return decoded;
}
function errorCode(value: unknown): string | undefined {
  return value && typeof value === 'object' && 'code' in value && typeof value.code === 'string' ? value.code : undefined;
}
function safeError(value: unknown): HttpError {
  if (value instanceof MonitorActionError) return value;
  const code = errorCode(value);
  if (code === 'HUMAN_PREPARATION_FAILED' && value instanceof Error) return new HttpError(409, value.message.slice(0, 8000));
  if (['WORKSPACE_CHANGED', 'WORKSPACE_CACHE_TAMPERED', 'WORKSPACE_ARTIFACT_MISMATCH'].includes(code ?? '')) return new HttpError(409, 'The review input has changed; this Artifact cannot be inspected.');
  if (code === 'ENOENT' || code === 'ENOTDIR') return new HttpError(409, 'The stored review input could not be found. The original or copy may have been moved or deleted.');
  if (code === 'HUMAN_TOOL_UNAVAILABLE') return new HttpError(409, 'Unable to start the registered program. Check its installation and tool settings.');
  if (code === 'HUMAN_TOOL_FAILED') return new HttpError(409, 'The registered program did not finish successfully. Check the program and tool settings.');
  if (code === 'HUMAN_TOOL_TIMEOUT') return new HttpError(504, 'The registered program timed out.');
  if (code === 'ARTIFACT_TOOL_TIMEOUT') return new HttpError(504, 'The tool timed out.');
  if (code === 'ARTIFACT_TOOL_FAILED') return new HttpError(409, 'Unable to run the tool. Check the input and registered program, then try again.');
  if (code === 'UNKNOWN_ARTIFACT_TOOL') return new HttpError(400, 'This tool is not registered for this Artifact.');
  if (code === 'ABORTED') return new HttpError(409, 'Tool execution was aborted.');
  if (code === 'EACCES' || code === 'EPERM') return new HttpError(409, 'Permission denied when reading the review input.');
  const message = value instanceof Error ? value.message : '';
  if (/claimed|reviewer who/i.test(message)) return new HttpError(403, 'You can only act on reviews claimed in this browser.');
  if (/waiting for a human|already completed|alarm delivery|lock review requires/i.test(message)) return new HttpError(409, 'The review status has changed or the review is not ready yet. Refresh the list.');
  if (/worker|saved.*configuration|saved.*settings/i.test(message)) return new HttpError(503, 'Unable to start the worker for the next review. Check the saved execution settings and resume the Run.');
  return new HttpError(400, 'Unable to read the requested Artifact range. Check the file path and read range.');
}
function protect(request: IncomingMessage, port: number): string {
  const host = request.headers.host;
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!host || !hosts.includes(host)) throw new HttpError(403, 'Connect using the local address of this monitor.');
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) throw new HttpError(403, 'Only requests from the same monitor page are allowed.');
  const site = request.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'External pages cannot access this monitor.');
  if (request.method !== 'GET' && request.method !== 'POST') throw new HttpError(405, 'Unsupported request method.');
  if (request.method === 'POST' && origin !== `http://${host}`) throw new HttpError(403, 'Only requests from the same monitor page are allowed.');
  if (request.method === 'GET' && (request.headers['transfer-encoding'] !== undefined || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0'))) throw new HttpError(400, 'GET requests must not contain a body.');
  return host;
}
function headers(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('X-Frame-Options', 'DENY');
}
function json(response: ServerResponse, value: unknown, status = 200): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

const cookieName = 'ccdd_monitor_session';
const bearerPattern = /^[A-Za-z0-9_-]{43}$/;
function tokenFrom(request: IncomingMessage): string | undefined {
  const matches = (request.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
  if (matches.length !== 1) return undefined;
  const token = matches[0].slice(cookieName.length + 1);
  return bearerPattern.test(token) ? token : undefined;
}
function reviewer(token: string): string { return `browser-${createHash('sha256').update(token).digest('hex').slice(0, 24)}`; }
function session(secret: Buffer, token: string): MonitorSession {
  return { reviewerId: reviewer(token), csrfToken: createHmac('sha256', secret).update(token).digest('base64url') };
}
function authenticate(request: IncomingMessage, secret: Buffer): string {
  const token = tokenFrom(request), supplied = request.headers['x-ccdd-csrf'];
  if (!token || typeof supplied !== 'string' || !bearerPattern.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(session(secret, token).csrfToken))) throw new HttpError(403, 'Unable to verify the reviewer session. Refresh the page and try again.');
  return reviewer(token);
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function bodyShape(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw new HttpError(400, 'Invalid request body fields.');
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'Send the request as JSON.');
  if (Number(request.headers['content-length'] ?? 0) > 32_768) throw new HttpError(413, 'The request body must be at most 32KiB.');
  return await new Promise((ok, no) => {
    const chunks: Buffer[] = []; let size = 0;
    const cleanup = () => { clearTimeout(timer); request.off('data', data); request.off('end', end); request.off('aborted', abort); request.off('error', no); };
    const fail = (error: Error) => { cleanup(); request.resume(); no(error); };
    const abort = () => fail(new HttpError(400, 'The request transfer was aborted.'));
    const data = (chunk: Buffer) => { size += chunk.length; if (size > 32_768) fail(new HttpError(413, 'The request body must be at most 32KiB.')); else chunks.push(chunk); };
    const end = () => { cleanup(); try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { no(new HttpError(400, 'Check the JSON request body.')); } };
    const timer = setTimeout(() => fail(new HttpError(408, 'The request body transfer timed out.')), 5_000);
    request.on('data', data); request.once('end', end); request.once('aborted', abort); request.once('error', no);
  });
}
async function staticAssets(): Promise<Map<string, [string, Buffer]>> {
  const root = new URL('../../monitor-ui/', import.meta.url);
  const assets = new Map<string, [string, Buffer]>();
  const visit = async (directory: URL, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(new URL(`${entry.name}/`, directory), `${path}/`);
      else if (entry.isFile()) {
        const extension = entry.name.split('.').at(-1);
        const mime = extension === 'html' ? 'text/html' : extension === 'js' ? 'text/javascript' : extension === 'css' ? 'text/css' : extension === 'svg' ? 'image/svg+xml' : undefined;
        if (mime) assets.set(path === '/index.html' ? '/' : path, [mime, await readFile(new URL(entry.name, directory))]);
      }
    }
  };
  await visit(root, '/');
  if (!assets.has('/')) throw new Error('Monitor UI files are missing. Rebuild the package.');
  return assets;
}

async function decorateDetail(detail: MonitorDetail, record: MonitorStoredRequest, reviewerId?: string): Promise<MonitorDetail> {
  const waiting = detail.request.kind === 'human' && detail.request.status === 'WAITING_HUMAN';
  const claimedByMe = Boolean(reviewerId && detail.request.claimedBy === reviewerId);
  const reservation = waiting ? activeTryClaim(record.request) : undefined;
  detail.human = {
    canClaim: waiting && !detail.request.claimedBy && !reservation && detail.request.workerState !== 'missing',
    canComplete: waiting && claimedByMe && Boolean(record.request.notifiedAt) && detail.request.workerState !== 'missing',
    claimedByMe,
    ...(reservation ? { tryClaim: { reviewerId: reservation.reviewerId, expiresAt: reservation.expiresAt, preparingByMe: reservation.reviewerId === reviewerId } } : {}),
  };
  detail.tools = [];
  detail.artifactPreview = record.request.configManifest ? 'tools' : 'legacy';
  if (detail.request.kind === 'human') {
    try {
      if (record.request.configManifest) {
        // A monitor GET only projects the stored manifest. Loading a TS config is executable work.
        detail.tools = describeReviewTools({ artifacts: record.request.artifacts, configManifest: record.request.configManifest, audience: 'human' })
          .map(tool => ({ name: tool.name, artifactId: tool.artifactId, operation: tool.operation, description: tool.description, inputSchema: tool.inputSchema }));
      } else {
        await authorizeWorkspace(record);
        const registry = await createHumanArtifactTools({ worktreePath: record.request.workspace.path, artifacts: record.request.artifacts, artifactTypes: record.request.artifactTypes, allowLegacy: true, signal: AbortSignal.timeout(5_000) });
        detail.tools = registry.tools.map(tool => ({ name: tool.name, artifactId: tool.artifactId, operation: tool.operation, description: tool.description, inputSchema: tool.inputSchema }));
      }
    } catch { detail.toolIssue = 'Unable to prepare tools for this review. Check the stored input and tool definitions.'; }
  }
  return detail;
}

/** Optional transport: GET observes; authenticated, explicit POST delegates durable Human actions. */
export async function startMonitor(options: MonitorSources & { port?: number } = {}): Promise<{ url: string; close(): Promise<void> }> {
  const requestedPort = options.port ?? 4318;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('The monitor port must be an integer between 0 and 65535.');
  const store = createMonitorStore(options);
  const assets = await staticAssets();
  const sessionSecret = randomBytes(32);
  const mutations = new Set<string>();
  let port = requestedPort, closing = false, closePromise: Promise<void> | undefined;
  const active = new Set<AbortController>();
  const jobs = new Set<Promise<void>>();
  const server = createServer({ maxHeaderSize: 16_384 }, (request, response) => {
    headers(response);
    const job = (async () => {
      const host = protect(request, port);
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new HttpError(400, 'Invalid request URL.');
      const url = new URL(request.url, `http://${host}`);
      if (closing) throw new HttpError(503, 'The monitor is shutting down.');
      const asset = assets.get(url.pathname);
      if (asset && request.method === 'GET') {
        parameters(url, []);
        response.writeHead(200, { 'content-type': `${asset[0]}; charset=utf-8` }); response.end(asset[1]); return;
      }
      if (url.pathname === '/api/session' && request.method === 'GET') {
        parameters(url, []);
        const token = tokenFrom(request) ?? randomBytes(32).toString('base64url');
        response.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
        json(response, session(sessionSecret, token)); return;
      }
      if (request.method === 'POST') {
        const validation = /^\/api\/projects\/([^/]+)\/validation$/.exec(url.pathname);
        if (validation) {
          parameters(url, []); authenticate(request, sessionSecret); bodyShape(await body(request), []);
          if (active.size >= MAX_ARTIFACT_READS) throw new HttpError(429, 'Other input is being inspected. Please try again shortly.');
          const context = await store.projectContext(id(validation[1]));
          if (!context) throw new HttpError(404, 'Project not found.');
          const controller = new AbortController();
          const disconnect = () => { if (!response.writableEnded) controller.abort(new Error('Monitor client disconnected')); };
          request.once('aborted', disconnect); response.once('close', disconnect); active.add(controller);
          const timer = setTimeout(() => controller.abort(new HttpError(504, 'Current input inspection timed out. Try again using the CLI.')), 30_000);
          try {
            const { plan } = await inspectProject({ ...context, recursive: true, signal: controller.signal });
            json(response, { plan, observedAt: new Date().toISOString() });
          } catch (error) {
            if (controller.signal.aborted) throw controller.signal.reason;
            throw new HttpError(409, 'Unable to inspect current input. Run ccdd-project config check to check the configuration and input.');
          } finally { clearTimeout(timer); request.off('aborted', disconnect); response.off('close', disconnect); active.delete(controller); }
          return;
        }
        const action = /^\/api\/requests\/([^/]+)\/([^/]+)\/(claim|complete|tools\/([^/]+))$/.exec(url.pathname);
        if (!action) throw new HttpError(405, 'This URL only accepts GET requests.');
        parameters(url, []);
        const reviewerId = authenticate(request, sessionSecret);
        const input = await body(request);
        const projectId = id(action[1]), requestId = id(action[2]);
        const key = `${projectId}/${requestId}`;
        if (mutations.has(key)) throw new HttpError(409, 'Another action is in progress for this review. Please try again shortly.');
        mutations.add(key);
        try {
          const record = await store.request(projectId, requestId);
          if (!record) throw new HttpError(404, 'Review request not found.');
          if (record.request.id !== requestId) throw new HttpError(409, 'The stored review identifier does not match.');
          if (action[3] === 'claim') {
            bodyShape(input, []);
            const controller = new AbortController();
            const disconnect = () => { if (!response.writableEnded) controller.abort(new Error('Monitor client disconnected.')); };
            response.once('close', disconnect); active.add(controller);
            const timer = setTimeout(() => controller.abort(new HttpError(504, 'Review preparation timed out.')), 900_000);
            try { await claimReview(record, reviewerId, controller.signal); }
            finally { clearTimeout(timer); response.off('close', disconnect); active.delete(controller); }
          } else if (action[3] === 'complete') {
            bodyShape(input, ['verdict', 'summary', 'evidence']);
            if ((input.verdict !== 'GREEN' && input.verdict !== 'RED') || typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 12_000 || !Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 100 || !input.evidence.every(item => typeof item === 'string' && item.trim().length > 0 && item.length <= 4_000)) throw new HttpError(400, 'Check the verdict, summary, and evidence list.');
            await completeReview(record, reviewerId, { verdict: input.verdict, summary: input.summary, evidence: input.evidence as string[] });
          } else {
            bodyShape(input, ['arguments']);
            if (!object(input.arguments)) throw new HttpError(400, 'Tool input must be a JSON object.');
            if (active.size >= MAX_ARTIFACT_READS) throw new HttpError(429, 'Other tools are running. Please try again shortly.');
            const controller = new AbortController();
            const disconnect = () => { if (!response.writableEnded) controller.abort(new Error('Monitor client disconnected')); };
            request.once('aborted', disconnect); response.once('close', disconnect); active.add(controller);
            const timer = setTimeout(() => controller.abort(new HttpError(504, 'The tool timed out.')), 120_000);
            try { json(response, { result: await executeReviewTool(record, reviewerId, id(action[4], 129), input.arguments, controller.signal) }); }
            finally { clearTimeout(timer); request.off('aborted', disconnect); response.off('close', disconnect); active.delete(controller); }
            return;
          }
          const updated = await store.detail(projectId, requestId);
          if (!updated) throw new HttpError(404, 'Review request not found.');
          json(response, await decorateDetail(updated, await store.request(projectId, requestId) ?? record, reviewerId));
        } finally { mutations.delete(key); }
        return;
      }
      if (url.pathname === '/api/runs') {
        parameters(url, ['project', 'limit', 'offset']);
        const project = url.searchParams.get('project');
        json(response, await store.runs({ project: project === null ? undefined : id(project), limit: number(url.searchParams.get('limit'), 50, 1, 100), offset: number(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER) })); return;
      }
      const graphRoute = /^\/api\/graphs\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (graphRoute) {
        parameters(url, []);
        const graph = await store.graph(id(graphRoute[1]), id(graphRoute[2]));
        if (!graph) throw new HttpError(404, 'Selected Run not found.');
        json(response, graph); return;
      }
      if (url.pathname === '/api/requests') {
        parameters(url, ['project', 'run', 'filter', 'lane', 'limit', 'offset']);
        const filter = url.searchParams.get('filter') ?? 'all';
        if (!['all', 'active', 'attention'].includes(filter)) throw new HttpError(400, 'Unknown request filter.');
        const projectValue = url.searchParams.get('project');
        const project = projectValue === null ? undefined : id(projectValue);
        const runValue = url.searchParams.get('run');
        const run = runValue === null ? undefined : id(runValue);
        if (run !== undefined && project === undefined) throw new HttpError(400, 'Select a project before selecting a Run.');
        const limit = number(url.searchParams.get('limit'), 50, 1, 100);
        const offset = number(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
        const lane = url.searchParams.get('lane') ?? undefined;
        if (lane !== undefined && !['requested', 'running', 'success', 'failure'].includes(lane)) throw new HttpError(400, 'Unknown Kanban column.');
        json(response, await store.overview({ project, run, filter: filter as MonitorFilter, lane: lane as MonitorLane | undefined, limit, offset })); return;
      }
      const detail = /^\/api\/requests\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (detail) {
        parameters(url, []);
        const result = await store.detail(id(detail[1]), id(detail[2]));
        if (!result) throw new HttpError(404, 'Review request not found.');
        const record = await store.request(id(detail[1]), id(detail[2]));
        const token = tokenFrom(request);
        json(response, record ? await decorateDetail(result, record, token ? reviewer(token) : undefined) : result); return;
      }
      const artifact = /^\/api\/requests\/([^/]+)\/([^/]+)\/artifacts\/([^/]+)$/.exec(url.pathname);
      if (!artifact) throw new HttpError(404, 'Request URL not found.');
      parameters(url, ['operation', 'path', 'startLine', 'lineCount', 'offset', 'limit']);
      if (active.size >= MAX_ARTIFACT_READS) { response.setHeader('Retry-After', '1'); throw new HttpError(429, 'Other Artifacts are being inspected. Please try again shortly.'); }
      const controller = new AbortController();
      const disconnect = () => { if (!response.writableEnded) controller.abort(new Error('Monitor client disconnected')); };
      request.once('aborted', disconnect); response.once('close', disconnect);
      const timer = setTimeout(() => controller.abort(new HttpError(504, 'Artifact inspection timed out. Try again with a smaller input.')), ARTIFACT_BUDGET_MS);
      active.add(controller);
      try {
        const projectId = id(artifact[1]), requestId = id(artifact[2]), artifactId = id(artifact[3]);
        const record = await store.request(projectId, requestId);
        controller.signal.throwIfAborted();
        if (!record) throw new HttpError(404, 'Review request not found.');
        if (record.request.id !== requestId) throw new HttpError(409, 'The stored review request identifier does not match.');
        if (record.request.configManifest) throw new HttpError(409, 'Inspect this Artifact with its registered tools. Human reviewers can use the programs provided in the Review tab.');
        await authorizeWorkspace(record);
        controller.signal.throwIfAborted();
        const handle = await reopenWorkspace(record.request.workspace, { signal: controller.signal });
        try {
          await handle.assertUnchanged();
          const expected = await readStoredArtifactScope({ repoPath: handle.descriptor.path, criticId: record.request.criticId });
          if (!expected || !isDeepStrictEqual(expected.artifacts, record.request.artifacts) || !isDeepStrictEqual(expected.artifactTypes, record.request.artifactTypes)) throw new HttpError(409, 'The stored Artifact scope does not match the review input definitions.');
          const viewer = await createArtifactViewer({ worktreePath: handle.descriptor.path, artifacts: record.request.artifacts, artifactTypes: record.request.artifactTypes, signal: handle.signal });
          const definition = viewer.listArtifacts().find(item => item.id === artifactId);
          if (!definition) throw new HttpError(404, 'This Artifact is not included in the review request.');
          const operation = url.searchParams.get('operation') ?? (definition.directory ? 'list' : 'read');
          if (operation !== 'read' && operation !== 'list') throw new HttpError(400, 'Unsupported Artifact inspection method.');
          const registry = createArtifactTools(viewer, { audience: 'viewer' });
          const toolName = `${operation}_${artifactId}`;
          const tool = registry.tools.find(item => item.name === toolName);
          if (!tool) throw new HttpError(400, 'This Artifact does not have the requested inspection tool.');
          const args: Record<string, unknown> = {};
          if (url.searchParams.has('path')) args.path = url.searchParams.get('path');
          for (const [key, minimum, maximum] of [['startLine', 1, Number.MAX_SAFE_INTEGER], ['lineCount', 1, 500], ['offset', 0, Number.MAX_SAFE_INTEGER], ['limit', 1, 200]] as const) {
            if (url.searchParams.has(key)) args[key] = number(url.searchParams.get(key), minimum, minimum, maximum);
          }
          const result = await registry.call(toolName, args);
          await handle.assertUnchanged();
          handle.signal.throwIfAborted();
          const page: MonitorArtifactPage = { artifact: { id: definition.id, path: definition.path, directory: definition.directory, description: tool.description }, result };
          json(response, page);
        } finally { await handle.close(); }
      } catch (error) { throw controller.signal.aborted ? controller.signal.reason : safeError(error); }
      finally {
        clearTimeout(timer); request.off('aborted', disconnect); response.off('close', disconnect); active.delete(controller);
      }
    })().catch(error => {
      const safe = safeError(error);
      if (safe.status === 405) response.setHeader('Allow', 'GET');
      json(response, { error: safe.message }, safe.status);
    }).finally(() => { jobs.delete(job); });
    jobs.add(job);
  });
  server.headersTimeout = 10_000; server.requestTimeout = 15_000;
  await new Promise<void>((ok, no) => { server.once('error', no); server.listen(requestedPort, '127.0.0.1', () => { server.off('error', no); ok(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to determine the local address of the monitor.');
  port = address.port;
  return {
    url: `http://127.0.0.1:${port}`,
    close() {
      if (!closePromise) {
        closing = true;
        for (const controller of active) controller.abort(new HttpError(503, 'The monitor is shutting down.'));
        closePromise = (async () => {
          await new Promise<void>((ok, no) => { server.close(error => error ? no(error) : ok()); server.closeIdleConnections(); });
          await Promise.allSettled([...jobs]);
        })();
      }
      return closePromise;
    },
  };
}
