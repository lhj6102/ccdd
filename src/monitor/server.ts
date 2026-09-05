import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createArtifactViewer, createArtifactTools } from '../artifacts/index.js';
import { prepareReviewRequests } from '../requester/index.js';
import { reopenWorkspace } from '../workspaces/index.js';
import type { ReviewRequest } from '../contracts.js';
import { createMonitorStore } from './store.js';
import { monitorHtml, monitorCss } from './page.js';
import type { MonitorArtifactPage, MonitorFilter, MonitorSources } from './types.js';

const ARTIFACT_BUDGET_MS = 10_000;
const MAX_ARTIFACT_READS = 2;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

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
function id(value: string): string {
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { throw new HttpError(400, '올바르지 않은 식별자입니다.'); }
  if (!identifier.test(decoded)) throw new HttpError(400, '올바르지 않은 식별자입니다.');
  return decoded;
}
function errorCode(value: unknown): string | undefined {
  return value && typeof value === 'object' && 'code' in value && typeof value.code === 'string' ? value.code : undefined;
}
function safeError(value: unknown): HttpError {
  if (value instanceof HttpError) return value;
  const code = errorCode(value);
  if (['WORKSPACE_CHANGED', 'WORKSPACE_CACHE_TAMPERED'].includes(code ?? '')) return new HttpError(409, '리뷰 입력이 변경되어 이 Artifact를 확인할 수 없습니다.');
  if (code === 'ENOENT' || code === 'ENOTDIR') return new HttpError(409, '보관된 리뷰 입력을 찾을 수 없습니다. 원본 또는 복사본이 이동·삭제되었을 수 있습니다.');
  if (code === 'EACCES' || code === 'EPERM') return new HttpError(409, '리뷰 입력을 읽을 권한이 없습니다.');
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
  if (request.method !== 'GET') throw new HttpError(405, '모니터는 조회 요청만 허용합니다.');
  if (request.headers['transfer-encoding'] !== undefined || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) throw new HttpError(400, '조회 요청에는 본문을 보낼 수 없습니다.');
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

/** Stored descriptors cannot expand access beyond the selected, registered state source. */
async function authorizeWorkspace(record: { request: ReviewRequest; repoPath: string; stateDir: string; repoId: string }): Promise<void> {
  const { request, repoPath, stateDir, repoId } = record;
  const descriptor = request.workspace;
  if (!descriptor || request.repoId !== repoId || request.snapshotHash !== descriptor.hash || !/^[a-f0-9]{64}$/.test(request.snapshotHash) ||
      !isAbsolute(repoPath) || resolve(repoPath) !== repoPath || !isAbsolute(stateDir) || resolve(stateDir) !== stateDir ||
      descriptor.sourcePath !== repoPath || descriptor.stateDir !== stateDir || await realpath(stateDir) !== stateDir ||
      descriptor.path !== (descriptor.mode === 'copy' ? join(stateDir, 'workspaces', descriptor.hash) : repoPath)) {
    throw new HttpError(409, '리뷰 입력과 저장된 프로젝트 정보가 일치하지 않습니다.');
  }
  if (descriptor.mode === 'lock' && await realpath(repoPath) !== repoPath) throw new HttpError(409, '원본 workspace의 경로가 변경되었습니다.');
}

/** Optional read-only transport. It never owns workers, changes results or creates broker state. */
export async function startMonitor(options: MonitorSources & { port?: number } = {}): Promise<{ url: string; close(): Promise<void> }> {
  const requestedPort = options.port ?? 4318;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('모니터 포트는 0~65535 사이의 정수여야 합니다.');
  const store = createMonitorStore(options);
  const client = await readFile(new URL('./client.js', import.meta.url), 'utf8');
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
      const staticContent: Record<string, [string, string]> = { '/': ['text/html', monitorHtml], '/style.css': ['text/css', monitorCss], '/client.js': ['text/javascript', client] };
      const asset = staticContent[url.pathname];
      if (asset) {
        parameters(url, []);
        response.writeHead(200, { 'content-type': `${asset[0]}; charset=utf-8` }); response.end(asset[1]); return;
      }
      if (url.pathname === '/api/requests') {
        parameters(url, ['project', 'filter', 'limit', 'offset']);
        const filter = url.searchParams.get('filter') ?? 'all';
        if (!['all', 'active', 'attention'].includes(filter)) throw new HttpError(400, '알 수 없는 요청 필터입니다.');
        const projectValue = url.searchParams.get('project');
        const project = projectValue === null ? undefined : id(projectValue);
        const limit = number(url.searchParams.get('limit'), 50, 1, 100);
        const offset = number(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
        json(response, await store.overview({ project, filter: filter as MonitorFilter, limit, offset })); return;
      }
      const detail = /^\/api\/requests\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (detail) {
        parameters(url, []);
        const result = await store.detail(id(detail[1]), id(detail[2]));
        if (!result) throw new HttpError(404, '리뷰 요청을 찾을 수 없습니다.');
        json(response, result); return;
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
          const expected = (await prepareReviewRequests({ repoPath: handle.descriptor.path, repoId: record.repoId, snapshotHash: record.request.snapshotHash, criticId: record.request.criticId }))[0];
          if (!expected || !isDeepStrictEqual(expected.artifacts, record.request.artifacts) || !isDeepStrictEqual(expected.artifactTypes, record.request.artifactTypes)) throw new HttpError(409, '저장된 Artifact 범위가 리뷰 입력의 정의와 일치하지 않습니다.');
          const viewer = await createArtifactViewer({ worktreePath: handle.descriptor.path, artifacts: record.request.artifacts, artifactTypes: record.request.artifactTypes, signal: handle.signal });
          const definition = viewer.listArtifacts().find(item => item.id === artifactId);
          if (!definition) throw new HttpError(404, '이 리뷰 요청에 포함된 Artifact가 아닙니다.');
          const operation = url.searchParams.get('operation') ?? (definition.directory ? 'list' : 'read');
          if (operation !== 'read' && operation !== 'list') throw new HttpError(400, '지원하지 않는 Artifact 조회 방식입니다.');
          const registry = createArtifactTools(viewer);
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
