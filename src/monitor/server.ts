import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createArtifactViewer, createArtifactTools } from '../artifacts/index.js';
import { createHumanArtifactTools } from '../artifacts/human.js';
import type { MonitorStoredRequest } from './store.js';
import { readStoredArtifactScope } from '../requester/index.js';
import { reopenWorkspace } from '../workspaces/index.js';
import { createMonitorStore } from './store.js';
import { MonitorActionError, authorizeWorkspace, claimReview, completeReview, executeReviewTool } from './actions.js';
import type { MonitorArtifactPage, MonitorDetail, MonitorFilter, MonitorLane, MonitorSession, MonitorSources } from './types.js';

const ARTIFACT_BUDGET_MS = 10_000;
const MAX_ARTIFACT_READS = 2;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
class HttpError extends MonitorActionError {}

function parameters(url: URL, allowed: readonly string[]): void {
  for (const name of url.searchParams.keys()) {
    if (!allowed.includes(name) || url.searchParams.getAll(name).length !== 1) throw new HttpError(400, '알 수 없거나 중복된 조회 조건입니다.');
  }
}
function number(value: string | null, fallback: number, minimum: number, maximum: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new HttpError(400, `조회 범위는 ${minimum}~${maximum} 사이의 정수여야 합니다.`);
  return parsed;
}
function id(value: string, maximumLength = 128): string {
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { throw new HttpError(400, '올바르지 않은 식별자입니다.'); }
  if (decoded.length > maximumLength || !identifier.test(decoded)) throw new HttpError(400, '올바르지 않은 식별자입니다.');
  return decoded;
}
function errorCode(value: unknown): string | undefined {
  return value && typeof value === 'object' && 'code' in value && typeof value.code === 'string' ? value.code : undefined;
}
function safeError(value: unknown): HttpError {
  if (value instanceof MonitorActionError) return value;
  const code = errorCode(value);
  if (['WORKSPACE_CHANGED', 'WORKSPACE_CACHE_TAMPERED', 'WORKSPACE_ARTIFACT_MISMATCH'].includes(code ?? '')) return new HttpError(409, '리뷰 입력이 변경되어 이 Artifact를 확인할 수 없습니다.');
  if (code === 'ENOENT' || code === 'ENOTDIR') return new HttpError(409, '보관된 리뷰 입력을 찾을 수 없습니다. 원본 또는 복사본이 이동·삭제되었을 수 있습니다.');
  if (code === 'HUMAN_TOOL_UNAVAILABLE') return new HttpError(409, '등록된 프로그램을 시작할 수 없습니다. 설치 여부와 도구 설정을 확인하세요.');
  if (code === 'HUMAN_TOOL_FAILED') return new HttpError(409, '등록된 프로그램이 정상적으로 끝나지 않았습니다. 프로그램과 도구 설정을 확인하세요.');
  if (code === 'HUMAN_TOOL_TIMEOUT') return new HttpError(504, '등록된 프로그램의 실행 시간이 초과되었습니다.');
  if (code === 'UNKNOWN_ARTIFACT_TOOL') return new HttpError(400, '이 Artifact에 등록되지 않은 도구입니다.');
  if (code === 'ABORTED') return new HttpError(409, '도구 실행이 중단되었습니다.');
  if (code === 'EACCES' || code === 'EPERM') return new HttpError(409, '리뷰 입력을 읽을 권한이 없습니다.');
  const message = value instanceof Error ? value.message : '';
  if (/claimed|reviewer who/i.test(message)) return new HttpError(403, '이 브라우저에서 맡은 리뷰만 처리할 수 있습니다.');
  if (/waiting for a human|already completed|alarm delivery|lock review requires/i.test(message)) return new HttpError(409, '리뷰 상태가 변경되었거나 아직 준비되지 않았습니다. 목록을 새로고침하세요.');
  if (/worker|saved.*configuration|saved.*settings/i.test(message)) return new HttpError(503, '다음 리뷰의 작업자를 시작할 수 없습니다. 저장된 실행 설정을 확인하고 해당 Run을 재개하세요.');
  return new HttpError(400, '요청된 범위의 Artifact를 읽을 수 없습니다. 파일 경로와 읽기 범위를 확인하세요.');
}
function protect(request: IncomingMessage, port: number): string {
  const host = request.headers.host;
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!host || !hosts.includes(host)) throw new HttpError(403, '이 모니터의 로컬 주소로 접속하세요.');
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) throw new HttpError(403, '같은 모니터 화면에서 보낸 요청만 허용합니다.');
  const site = request.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError(403, '외부 페이지에서 이 모니터에 접근할 수 없습니다.');
  if (request.method !== 'GET' && request.method !== 'POST') throw new HttpError(405, '지원하지 않는 요청 방식입니다.');
  if (request.method === 'POST' && origin !== `http://${host}`) throw new HttpError(403, '같은 모니터 화면에서 보낸 요청만 허용합니다.');
  if (request.method === 'GET' && (request.headers['transfer-encoding'] !== undefined || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0'))) throw new HttpError(400, '조회 요청에는 본문을 보낼 수 없습니다.');
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
  if (!token || typeof supplied !== 'string' || !bearerPattern.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(session(secret, token).csrfToken))) throw new HttpError(403, '리뷰어 세션을 확인할 수 없습니다. 화면을 새로고침한 후 다시 시도하세요.');
  return reviewer(token);
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function bodyShape(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw new HttpError(400, '요청 본문의 항목이 올바르지 않습니다.');
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'JSON 형식으로 요청하세요.');
  if (Number(request.headers['content-length'] ?? 0) > 32_768) throw new HttpError(413, '요청 본문은 32KiB 이하여야 합니다.');
  return await new Promise((ok, no) => {
    const chunks: Buffer[] = []; let size = 0;
    const cleanup = () => { clearTimeout(timer); request.off('data', data); request.off('end', end); request.off('aborted', abort); request.off('error', no); };
    const fail = (error: Error) => { cleanup(); request.resume(); no(error); };
    const abort = () => fail(new HttpError(400, '요청 전송이 중단되었습니다.'));
    const data = (chunk: Buffer) => { size += chunk.length; if (size > 32_768) fail(new HttpError(413, '요청 본문은 32KiB 이하여야 합니다.')); else chunks.push(chunk); };
    const end = () => { cleanup(); try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { no(new HttpError(400, 'JSON 요청 본문을 확인하세요.')); } };
    const timer = setTimeout(() => fail(new HttpError(408, '요청 본문 전송 시간이 초과되었습니다.')), 5_000);
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
  if (!assets.has('/')) throw new Error('모니터 화면 파일이 없습니다. 패키지를 다시 빌드하세요.');
  return assets;
}

async function decorateDetail(detail: MonitorDetail, record: MonitorStoredRequest, reviewerId?: string): Promise<MonitorDetail> {
  const waiting = detail.request.kind === 'human' && detail.request.status === 'WAITING_HUMAN';
  const claimedByMe = Boolean(reviewerId && detail.request.claimedBy === reviewerId);
  detail.human = {
    canClaim: waiting && !detail.request.claimedBy && detail.request.workerState !== 'missing',
    canComplete: waiting && claimedByMe && Boolean(record.request.notifiedAt) && detail.request.workerState !== 'missing',
    claimedByMe,
  };
  detail.tools = [];
  if (detail.request.kind === 'human') {
    try {
      await authorizeWorkspace(record);
      const registry = await createHumanArtifactTools({ worktreePath: record.request.workspace.path, artifacts: record.request.artifacts, artifactTypes: record.request.artifactTypes, allowLegacy: true, signal: AbortSignal.timeout(5_000) });
      detail.tools = registry.tools.map(tool => ({ name: tool.name, artifactId: tool.artifactId, operation: tool.operation, description: tool.description, inputSchema: tool.inputSchema }));
    } catch { detail.toolIssue = '이 리뷰의 도구를 준비할 수 없습니다. 보관된 입력과 도구 정의를 확인하세요.'; }
  }
  return detail;
}

/** Optional transport: GET observes; authenticated, explicit POST delegates durable Human actions. */
export async function startMonitor(options: MonitorSources & { port?: number } = {}): Promise<{ url: string; close(): Promise<void> }> {
  const requestedPort = options.port ?? 4318;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('모니터 포트는 0~65535 사이의 정수여야 합니다.');
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
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new HttpError(400, '올바르지 않은 조회 주소입니다.');
      const url = new URL(request.url, `http://${host}`);
      if (closing) throw new HttpError(503, '모니터를 종료하고 있습니다.');
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
        const action = /^\/api\/requests\/([^/]+)\/([^/]+)\/(claim|complete|tools\/([^/]+))$/.exec(url.pathname);
        if (!action) throw new HttpError(405, '이 주소는 조회 요청만 허용합니다.');
        parameters(url, []);
        const reviewerId = authenticate(request, sessionSecret);
        const input = await body(request);
        const projectId = id(action[1]), requestId = id(action[2]);
        const key = `${projectId}/${requestId}`;
        if (mutations.has(key)) throw new HttpError(409, '이 리뷰의 다른 작업을 처리하고 있습니다. 잠시 후 다시 시도하세요.');
        mutations.add(key);
        try {
          const record = await store.request(projectId, requestId);
          if (!record) throw new HttpError(404, '리뷰 요청을 찾을 수 없습니다.');
          if (record.request.id !== requestId) throw new HttpError(409, '저장된 리뷰 식별자가 일치하지 않습니다.');
          if (action[3] === 'claim') {
            bodyShape(input, []); await claimReview(record, reviewerId);
          } else if (action[3] === 'complete') {
            bodyShape(input, ['verdict', 'summary', 'evidence']);
            if ((input.verdict !== 'GREEN' && input.verdict !== 'RED') || typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 12_000 || !Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 100 || !input.evidence.every(item => typeof item === 'string' && item.trim().length > 0 && item.length <= 4_000)) throw new HttpError(400, '판정, 요약과 근거 목록을 확인하세요.');
            await completeReview(record, reviewerId, { verdict: input.verdict, summary: input.summary, evidence: input.evidence as string[] });
          } else {
            bodyShape(input, ['arguments']);
            if (!object(input.arguments)) throw new HttpError(400, '도구 입력은 JSON 객체여야 합니다.');
            if (active.size >= MAX_ARTIFACT_READS) throw new HttpError(429, '다른 도구를 처리하고 있습니다. 잠시 후 다시 시도하세요.');
            const controller = new AbortController();
            const disconnect = () => { if (!response.writableEnded) controller.abort(new Error('Monitor client disconnected')); };
            request.once('aborted', disconnect); response.once('close', disconnect); active.add(controller);
            const timer = setTimeout(() => controller.abort(new HttpError(504, '도구 실행 시간이 초과되었습니다.')), 120_000);
            try { json(response, { result: await executeReviewTool(record, reviewerId, id(action[4], 129), input.arguments, controller.signal) }); }
            finally { clearTimeout(timer); request.off('aborted', disconnect); response.off('close', disconnect); active.delete(controller); }
            return;
          }
          const updated = await store.detail(projectId, requestId);
          if (!updated) throw new HttpError(404, '리뷰 요청을 찾을 수 없습니다.');
          json(response, await decorateDetail(updated, record, reviewerId));
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
        if (!graph) throw new HttpError(404, '선택한 실행을 찾을 수 없습니다.');
        json(response, graph); return;
      }
      if (url.pathname === '/api/requests') {
        parameters(url, ['project', 'run', 'filter', 'lane', 'limit', 'offset']);
        const filter = url.searchParams.get('filter') ?? 'all';
        if (!['all', 'active', 'attention'].includes(filter)) throw new HttpError(400, '알 수 없는 요청 필터입니다.');
        const projectValue = url.searchParams.get('project');
        const project = projectValue === null ? undefined : id(projectValue);
        const runValue = url.searchParams.get('run');
        const run = runValue === null ? undefined : id(runValue);
        if (run !== undefined && project === undefined) throw new HttpError(400, '실행을 선택하려면 프로젝트를 먼저 선택하세요.');
        const limit = number(url.searchParams.get('limit'), 50, 1, 100);
        const offset = number(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
        const lane = url.searchParams.get('lane') ?? undefined;
        if (lane !== undefined && !['requested', 'running', 'success', 'failure'].includes(lane)) throw new HttpError(400, '알 수 없는 칸반 열입니다.');
        json(response, await store.overview({ project, run, filter: filter as MonitorFilter, lane: lane as MonitorLane | undefined, limit, offset })); return;
      }
      const detail = /^\/api\/requests\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (detail) {
        parameters(url, []);
        const result = await store.detail(id(detail[1]), id(detail[2]));
        if (!result) throw new HttpError(404, '리뷰 요청을 찾을 수 없습니다.');
        const record = await store.request(id(detail[1]), id(detail[2]));
        const token = tokenFrom(request);
        json(response, record ? await decorateDetail(result, record, token ? reviewer(token) : undefined) : result); return;
      }
      const artifact = /^\/api\/requests\/([^/]+)\/([^/]+)\/artifacts\/([^/]+)$/.exec(url.pathname);
      if (!artifact) throw new HttpError(404, '조회 주소를 찾을 수 없습니다.');
      parameters(url, ['operation', 'path', 'startLine', 'lineCount', 'offset', 'limit']);
      if (active.size >= MAX_ARTIFACT_READS) { response.setHeader('Retry-After', '1'); throw new HttpError(429, '다른 Artifact를 확인하고 있습니다. 잠시 후 다시 시도하세요.'); }
      const controller = new AbortController();
      const disconnect = () => { if (!response.writableEnded) controller.abort(new Error('Monitor client disconnected')); };
      request.once('aborted', disconnect); response.once('close', disconnect);
      const timer = setTimeout(() => controller.abort(new HttpError(504, 'Artifact 확인 시간이 초과되었습니다. 더 작은 입력으로 다시 시도하세요.')), ARTIFACT_BUDGET_MS);
      active.add(controller);
      try {
        const projectId = id(artifact[1]), requestId = id(artifact[2]), artifactId = id(artifact[3]);
        const record = await store.request(projectId, requestId);
        controller.signal.throwIfAborted();
        if (!record) throw new HttpError(404, '리뷰 요청을 찾을 수 없습니다.');
        if (record.request.id !== requestId) throw new HttpError(409, '저장된 리뷰 요청의 식별자가 일치하지 않습니다.');
        await authorizeWorkspace(record);
        controller.signal.throwIfAborted();
        const handle = await reopenWorkspace(record.request.workspace, { signal: controller.signal });
        try {
          await handle.assertUnchanged();
          const expected = await readStoredArtifactScope({ repoPath: handle.descriptor.path, criticId: record.request.criticId });
          if (!expected || !isDeepStrictEqual(expected.artifacts, record.request.artifacts) || !isDeepStrictEqual(expected.artifactTypes, record.request.artifactTypes)) throw new HttpError(409, '저장된 Artifact 범위가 리뷰 입력의 정의와 일치하지 않습니다.');
          const viewer = await createArtifactViewer({ worktreePath: handle.descriptor.path, artifacts: record.request.artifacts, artifactTypes: record.request.artifactTypes, signal: handle.signal });
          const definition = viewer.listArtifacts().find(item => item.id === artifactId);
          if (!definition) throw new HttpError(404, '이 리뷰 요청에 포함된 Artifact가 아닙니다.');
          const operation = url.searchParams.get('operation') ?? (definition.directory ? 'list' : 'read');
          if (operation !== 'read' && operation !== 'list') throw new HttpError(400, '지원하지 않는 Artifact 조회 방식입니다.');
          const registry = createArtifactTools(viewer, { audience: 'viewer' });
          const toolName = `${operation}_${artifactId}`;
          const tool = registry.tools.find(item => item.name === toolName);
          if (!tool) throw new HttpError(400, '이 Artifact에는 해당 조회 도구가 없습니다.');
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
  if (!address || typeof address === 'string') throw new Error('모니터의 로컬 주소를 확인할 수 없습니다.');
  port = address.port;
  return {
    url: `http://127.0.0.1:${port}`,
    close() {
      if (!closePromise) {
        closing = true;
        for (const controller of active) controller.abort(new HttpError(503, '모니터를 종료하고 있습니다.'));
        closePromise = (async () => {
          await new Promise<void>((ok, no) => { server.close(error => error ? no(error) : ok()); server.closeIdleConnections(); });
          await Promise.allSettled([...jobs]);
        })();
      }
      return closePromise;
    },
  };
}
