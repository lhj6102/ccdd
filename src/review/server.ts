import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { createBroker, readStateContext } from '../broker/index.js';
import { activeTryClaim } from '../broker/human-claims.js';
import { withProjectStore } from '../project/store.js';
import { createWorkspaceManifest, openWorkspaceBlob, type WorkspaceManifest } from '../workspaces/transfer.js';
import { ensureRunWorker } from '../worker-client.js';
import type { ReviewRequest } from '../contracts.js';
import type { HumanPreparation } from '../executors/human-preparation.js';
import { packageVersion } from '../runtime-paths.js';
import { portableReview } from './types.js';

export interface ReviewServerOptions {
  stateDir: string;
  reviewers: Record<string, string>;
  host?: string;
  port?: number;
}
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (value: string) => createHash('sha256').update(value).digest();
const identifier = (value: string) => { if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new HttpError(400, 'Invalid request identifier.'); return value; };
function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value));
}
function shape(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw new HttpError(400, 'Invalid request body.');
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256) throw new HttpError(400, 'Missing or invalid action identifier.');
  return value;
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'Send an application/json body.');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128 * 1024) throw new HttpError(413, 'Action body exceeds 128 KiB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON body.'); }
}

/** A download/action transport. Only explicit POST actions open the Broker. */
export async function startReviewServer(options: ReviewServerOptions): Promise<{ url: string; close(): Promise<void> }> {
  const context = readStateContext(options.stateDir);
  if (!object(options.reviewers) || !Object.keys(options.reviewers).length) throw new Error('At least one reviewer credential is required.');
  const credentials = Object.entries(options.reviewers).map(([id, token]) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('Reviewer credentials require an ID and a random base64url token of at least 32 characters.');
    return { id, hash: digest(token) };
  });
  if (new Set(credentials.map(entry => entry.hash.toString('hex'))).size !== credentials.length) throw new Error('Each reviewer needs a distinct credential.');
  const requestedPort = options.port ?? 4320;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('Invalid review server port.');
  const host = options.host ?? '127.0.0.1';
  const jobs = new Set<Promise<void>>(), active = new Set<AbortController>();
  const manifests = new Map<string, Promise<WorkspaceManifest>>();
  let closing = false;
  const readRequest = (id: string) => withProjectStore(context.stateDir, db => {
    const row = db.prepare('SELECT data FROM requests WHERE id=?').get(id);
    return row ? JSON.parse(String(row.data)) as ReviewRequest : null;
  }, null);
  const authenticate = (request: IncomingMessage) => {
    if (request.headers.origin || request.headers['sec-fetch-site']) throw new HttpError(403, 'Use the CCDD review client for authenticated remote actions.');
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ') || authorization.length > 264) throw new HttpError(401, 'A reviewer credential is required.');
    const hash = digest(authorization.slice(7));
    const credential = credentials.find(entry => timingSafeEqual(entry.hash, hash));
    if (!credential) throw new HttpError(401, 'Invalid reviewer credential.');
    return credential.id;
  };
  const manifestFor = (request: ReviewRequest) => {
    let pending = manifests.get(request.snapshotHash);
    if (!pending) {
      // This reads immutable snapshot files and verifies their identity; it never
      // evaluates configuration or modifies review state.
      pending = createWorkspaceManifest(request.workspace);
      manifests.set(request.snapshotHash, pending);
      pending.catch(() => { manifests.delete(request.snapshotHash); });
      if (manifests.size > 16) manifests.delete(manifests.keys().next().value!);
    }
    return pending;
  };
  const server = createServer({ maxHeaderSize: 16_384 }, (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const controller = new AbortController(); active.add(controller);
    const disconnect = () => { if (!response.writableEnded) controller.abort(new Error('Review client disconnected.')); };
    response.once('close', disconnect);
    const job = (async () => {
      if (closing) throw new HttpError(503, 'Review server is stopping.');
      if (active.size > 32) throw new HttpError(429, 'Too many concurrent review transfers.');
      const reviewerId = authenticate(request);
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new HttpError(400, 'Invalid review route.');
      const url = new URL(request.url, 'http://review.local');
      if (request.method === 'GET' && url.pathname === '/session') {
        json(response, { reviewerId, packageVersion }); return;
      }
      if (request.method === 'GET' && url.pathname === '/requests') {
        if ([...url.searchParams.keys()].some(key => !['limit', 'offset'].includes(key))) throw new HttpError(400, 'Unknown query parameter.');
        const limit = Number(url.searchParams.get('limit') ?? 100), offset = Number(url.searchParams.get('offset') ?? 0);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'Invalid pagination.');
        const result = withProjectStore(context.stateDir, db => db.prepare("SELECT data FROM requests WHERE json_extract(data,'$.profile.kind')='human' ORDER BY json_extract(data,'$.createdAt') DESC, rowid DESC LIMIT ? OFFSET ?").all(limit, offset).map(row => {
          const stored = JSON.parse(String(row.data)) as ReviewRequest;
          const preparation = activeTryClaim(stored);
          return { id: stored.id, runId: stored.runId, title: stored.title, status: stored.status,
            claimedBy: stored.claimedBy ?? null, preparation: preparation ? { reviewerId: preparation.reviewerId, expiresAt: preparation.expiresAt } : null,
            remoteSupported: stored.workspace.mode === 'copy' && Boolean(stored.configManifest) };
        }), []);
        json(response, result); return;
      }
      const match = /^\/requests\/([^/]+)(?:\/(snapshot|blobs\/([a-f0-9]{64})|try-claim|renew|release|confirm|authorize-tool|tool-receipt|submit))?$/.exec(url.pathname);
      if (!match || url.search) throw new HttpError(404, 'Unknown review route.');
      const id = identifier(match[1]), action = match[2];
      const stored = readRequest(id);
      if (!stored) throw new HttpError(404, 'Unknown review request.');
      const portable = portableReview(stored);
      if (request.method === 'GET') {
        if (!action) { json(response, { request: portable, status: stored.status }); return; }
        const reservation = activeTryClaim(stored);
        if (stored.status !== 'WAITING_HUMAN' || (stored.claimedBy !== reviewerId && reservation?.reviewerId !== reviewerId)) throw new HttpError(403, 'Reserve this review before downloading its input.');
        if (action === 'snapshot') { json(response, await manifestFor(stored)); return; }
        if (match[3]) {
          const manifest = await manifestFor(stored);
          const blob = await openWorkspaceBlob(stored.workspace, manifest, match[3], { signal: controller.signal });
          response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': blob.size });
          await pipeline(blob.stream, response, { signal: controller.signal }); return;
        }
        throw new HttpError(405, 'This route requires POST.');
      }
      if (request.method !== 'POST') throw new HttpError(405, 'Use GET or POST.');
      const input = await readBody(request);
      const broker = createBroker(context);
      try {
        if (action === 'try-claim') {
          shape(input, []);
          const attempt = broker.tryClaimHuman(id, reviewerId);
          json(response, { attempt, request: portable });
        } else if (action === 'renew' || action === 'release') {
          shape(input, ['attemptId']); const attemptId = string(input.attemptId);
          json(response, action === 'renew' ? broker.renewHumanTryClaim(id, reviewerId, attemptId) : { released: broker.releaseHumanTryClaim(id, reviewerId, attemptId) });
        } else if (action === 'confirm') {
          shape(input, ['attemptId', 'preparation']);
          const confirmed = broker.confirmHumanClaim(id, reviewerId, string(input.attemptId), input.preparation as HumanPreparation);
          json(response, { request: portableReview(confirmed) });
        } else if (action === 'authorize-tool' || action === 'tool-receipt') {
          shape(input, ['attemptId', 'toolName', 'arguments']);
          const args = { reviewerId, attemptId: string(input.attemptId), toolName: string(input.toolName), arguments: input.arguments ?? {} };
          if (action === 'authorize-tool') json(response, { tool: broker.authorizeRemoteHumanTool(id, args) });
          else { broker.recordRemoteHumanTool(id, args); json(response, { ok: true }); }
        } else if (action === 'submit') {
          shape(input, ['attemptId', 'result']);
          const current = broker.getRequest(id);
          if (!current || current.claimedBy !== reviewerId || current.claimAttemptId !== string(input.attemptId)) throw new HttpError(409, 'This Claim no longer belongs to this attempt.');
          const completed = await broker.completeHuman(id, { reviewerId, result: input.result });
          if (!completed) throw new HttpError(404, 'The completed request is unavailable.');
          const run = broker.getRun(completed.runId)!;
          if (run.status === 'QUEUED') await ensureRunWorker({ broker, context, run });
          json(response, { id, status: completed.status, result: completed.result });
        } else throw new HttpError(404, 'Unknown review action.');
      } finally { await broker.close(); }
    })().catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      json(response, { error: error instanceof Error ? error.message : 'Review action failed.' }, error instanceof HttpError ? error.status : 409);
    }).finally(() => { active.delete(controller); response.off('close', disconnect); jobs.delete(job); });
    jobs.add(job);
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot determine review server address.');
  let closePromise: Promise<void> | undefined;
  return { url: `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`,
    close() {
      return closePromise ??= (async () => {
        closing = true; for (const controller of active) controller.abort(new Error('Review server stopped.'));
        await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
        await Promise.allSettled([...jobs]);
      })();
    },
  };
}
