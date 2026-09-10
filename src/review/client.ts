import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ReviewResult, WorkspaceDescriptor } from '../contracts.js';
import type { HumanTryClaim } from '../broker/human-claims.js';
import { materializeWorkspace, validateWorkspaceManifest, type WorkspaceTransferProgress } from '../workspaces/transfer.js';
import { reopenWorkspace } from '../workspaces/index.js';
import { prepareHumanReview } from '../executors/human-preparation.js';
import { createReviewTools, describeReviewTools } from '../tools/runner.js';
import { packageVersion } from '../runtime-paths.js';
import type { PortableReview } from './types.js';

export interface RemoteReviewOptions {
  server: string;
  token: string;
  stateDir: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (event: { phase: 'download' | 'environment' | 'claimed'; transfer?: WorkspaceTransferProgress }) => void;
}
interface LocalReviewSession {
  version: 1;
  server: string;
  reviewerId: string;
  attemptId: string;
  request: PortableReview;
  workspace: WorkspaceDescriptor;
}
export interface PreparedRemoteReview {
  requestId: string;
  reviewerId: string;
  snapshotHash: string;
  workspacePath: string;
  downloadedFiles: number;
  downloadedBytes: number;
  reusedFiles: number;
}
const requestId = (id: string) => { if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid review request identifier.'); return id; };

function transport(options: RemoteReviewOptions) {
  const server = new URL(options.server);
  if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password || server.search || server.hash || !['', '/'].includes(server.pathname)) {
    throw new Error('Use the HTTP(S) origin of the review server without credentials or a path.');
  }
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.token)) throw new Error('Invalid reviewer token format.');
  const timeoutMs = options.timeoutMs ?? 900_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) throw new Error('Review request timeout must be between 1 and 86400000 ms.');
  const send = async (route: string, input?: unknown, signal = options.signal): Promise<Response> => {
    signal?.throwIfAborted();
    const response = await fetch(new URL(route, server), { method: input === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${options.token}`, ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!response.ok) {
      const message = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(message.error ?? `Review server returned HTTP ${response.status}.`);
    }
    return response;
  };
  return { server: server.origin, send,
    async json<T>(route: string, input?: unknown, signal?: AbortSignal): Promise<T> { return await (await send(route, input, signal)).json() as T; },
  };
}

async function connect(options: RemoteReviewOptions) {
  const api = transport(options);
  const identity = await api.json<{ reviewerId: string; packageVersion: string }>('/session');
  if (identity.packageVersion !== packageVersion) throw new Error(`Use @ccdd/project ${identity.packageVersion} to match the review server (this client is ${packageVersion}).`);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(identity.reviewerId)) throw new Error('Invalid reviewer identity from server.');
  const root = resolve(options.stateDir);
  const sessionPath = (id: string) => join(root, 'review-sessions', createHash('sha256').update(JSON.stringify([api.server, identity.reviewerId, requestId(id)])).digest('hex') + '.json');
  const readSession = async (id: string): Promise<LocalReviewSession> => {
    const stored = JSON.parse(await readFile(sessionPath(id), 'utf8')) as LocalReviewSession;
    if (stored.version !== 1 || stored.server !== api.server || stored.reviewerId !== identity.reviewerId || stored.request?.id !== id || stored.request.packageVersion !== packageVersion || stored.workspace?.hash !== stored.request.snapshotHash || stored.workspace.stateDir !== root) throw new Error('Prepared review session does not match this client. Claim this review again.');
    requestId(stored.request.runId); requestId(stored.attemptId);
    return stored;
  };
  const saveSession = async (session: LocalReviewSession) => {
    const directory = join(root, 'review-sessions'); await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${randomUUID()}.json`);
    await writeFile(temporary, JSON.stringify(session), { mode: 0o600, flag: 'wx' });
    await rename(temporary, sessionPath(session.request.id));
  };
  return { ...api, root, reviewerId: identity.reviewerId, readSession, saveSession };
}

export async function listRemoteReviews(options: RemoteReviewOptions, { limit = 100, offset = 0 }: { limit?: number; offset?: number } = {}): Promise<unknown> {
  const api = await connect(options);
  return api.json(`/requests?limit=${limit}&offset=${offset}`);
}

export async function showRemoteReview(id: string, options: RemoteReviewOptions): Promise<unknown> {
  const api = await connect(options);
  const { request, status } = await api.json<{ request: PortableReview; status: string }>(`/requests/${requestId(id)}`);
  return { id: request.id, title: request.title, status, claimedBy: request.claimedBy,
    instruction: request.payload.instruction, artifacts: request.artifacts,
    ...(request.artifactGroups ? { artifactGroups: request.artifactGroups } : {}),
    environmentRequirements: request.configManifest?.envRequirements ?? {},
    tools: request.configManifest ? describeReviewTools({ artifacts: request.artifacts, configManifest: request.configManifest, audience: 'human' }) : [],
  };
}

export async function claimRemoteReview(id: string, options: RemoteReviewOptions): Promise<PreparedRemoteReview> {
  requestId(id);
  const api = await connect(options);
  const route = `/requests/${id}`;
  const current = await api.json<{ request: PortableReview; status: string }>(route);
  if (current.status !== 'WAITING_HUMAN') throw new Error('Request is not waiting for a Human review.');
  if (current.request.claimedBy) {
    if (current.request.claimedBy !== api.reviewerId) throw new Error('This review is already claimed by another reviewer.');
    const session = await api.readSession(id);
    if (session.attemptId !== current.request.claimAttemptId) throw new Error('This Claim was prepared by another local session.');
    const handle = await reopenWorkspace(session.workspace, { signal: options.signal });
    try { await handle.assertUnchanged(); } finally { await handle.close(); }
    return { requestId: id, reviewerId: api.reviewerId, snapshotHash: session.request.snapshotHash, workspacePath: session.workspace.path, downloadedFiles: 0, downloadedBytes: 0, reusedFiles: 0 };
  }
  const { attempt, request } = await api.json<{ attempt: HumanTryClaim; request: PortableReview }>(`${route}/try-claim`, {});
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const renewalController = new AbortController();
  let renewal: Promise<unknown> | undefined;
  const heartbeat = setInterval(() => {
    if (renewal) return;
    renewal = api.json(`${route}/renew`, { attemptId: attempt.id }, AbortSignal.any([signal, renewalController.signal, AbortSignal.timeout(15_000)]))
      .catch(error => { if (!renewalController.signal.aborted) controller.abort(error); }).finally(() => { renewal = undefined; });
  }, 20_000);
  try {
    if (request.id !== id || request.packageVersion !== packageVersion || attempt.reviewerId !== api.reviewerId) throw new Error('Invalid Try Claim response.');
    requestId(request.runId); requestId(attempt.id);
    const manifest = validateWorkspaceManifest(await api.json(`${route}/snapshot`, undefined, signal));
    if (manifest.hash !== request.snapshotHash) throw new Error('Downloaded manifest does not match this review.');
    options.onProgress?.({ phase: 'download' });
    const imported = await materializeWorkspace({ manifest, stateDir: api.root, signal,
      fetchBlob: async (hash, downloadSignal) => {
        const response = await api.send(`${route}/blobs/${hash}`, undefined, downloadSignal);
        if (!response.body) throw new Error('Missing snapshot file body.');
        return response.body;
      }, onProgress: transfer => options.onProgress?.({ phase: 'download', transfer }),
    });
    options.onProgress?.({ phase: 'environment' });
    const preparation = await prepareHumanReview(request, imported.descriptor, join(api.root, 'runs', request.runId, id, 'preparation', attempt.id), signal);
    const session: LocalReviewSession = { version: 1, server: api.server, reviewerId: api.reviewerId, attemptId: attempt.id, request, workspace: imported.descriptor };
    // Keep the prepared session before confirmation, so a lost confirmation response
    // can be recovered by checking the authoritative Claim with the same attempt ID.
    await api.saveSession(session);
    signal.throwIfAborted();
    await api.json(`${route}/confirm`, { attemptId: attempt.id, preparation }, signal);
    options.onProgress?.({ phase: 'claimed' });
    return { requestId: id, reviewerId: api.reviewerId, snapshotHash: request.snapshotHash, workspacePath: imported.descriptor.path,
      downloadedFiles: imported.downloadedFiles, downloadedBytes: imported.downloadedBytes, reusedFiles: imported.reusedFiles };
  } catch (error) {
    // Best-effort release is conditional on the attempt; loss of network is covered
    // by lease expiry, and cannot release another reviewer's newer reservation.
    await api.json(`${route}/release`, { attemptId: attempt.id }, AbortSignal.timeout(5_000)).catch(() => {});
    throw error;
  } finally { clearInterval(heartbeat); renewalController.abort(); await renewal; }
}

export async function executeRemoteHumanTool(id: string, toolName: string, args: Record<string, unknown>, options: RemoteReviewOptions): Promise<unknown> {
  const api = await connect(options), session = await api.readSession(requestId(id));
  const action = { attemptId: session.attemptId, toolName, arguments: args };
  await api.json(`/requests/${id}/authorize-tool`, action);
  const handle = await reopenWorkspace(session.workspace, { signal: options.signal });
  try {
    await handle.assertUnchanged();
    const request = session.request;
    const registry = await createReviewTools({ worktreePath: session.workspace.path, artifacts: request.artifacts,
      artifactGroups: request.artifactGroups, artifactTypes: request.artifactTypes, configManifest: request.configManifest,
      criticId: request.criticId, audience: 'human', runDir: join(api.root, 'runs', request.runId, id, 'human-tools'), signal: handle.signal });
    try {
      registry.validateArguments(toolName, args);
      const result = await registry.call(toolName, args);
      await handle.assertUnchanged(); handle.signal.throwIfAborted();
      await api.json(`/requests/${id}/tool-receipt`, action);
      return result;
    } finally { await registry.close(); }
  } finally { await handle.close(); }
}

export async function submitRemoteHumanReview(id: string, result: Pick<ReviewResult, 'verdict' | 'summary' | 'evidence'>, options: RemoteReviewOptions): Promise<unknown> {
  const api = await connect(options), session = await api.readSession(requestId(id));
  const handle = await reopenWorkspace(session.workspace, { signal: options.signal });
  try {
    await handle.assertUnchanged(); handle.signal.throwIfAborted();
    return await api.json(`/requests/${id}/submit`, { attemptId: session.attemptId, result });
  } finally { await handle.close(); }
}
