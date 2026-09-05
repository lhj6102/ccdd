import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';

/** Paths only: credentials are resolved in the worker and never stored in review state. */
export interface PiOptions { authFile?: string; codexAuthFile?: string }

export class PiAuthError extends Error {
  readonly code: string;
  readonly remedy: string;
  constructor(code: string, message: string, remedy: string) {
    super(message); this.name = 'PiAuthError'; this.code = code; this.remedy = remedy;
  }
}

const unavailable = () => new PiAuthError('AUTHENTICATION_UNAVAILABLE', '명시한 인증 파일을 읽을 수 없습니다.', '인증 파일 경로와 읽기 권한을 확인하세요. 인증 파일은 리뷰 workspace 밖에 두세요.');
const invalid = () => new PiAuthError('AUTHENTICATION_INVALID', '명시한 인증 파일의 형식이 올바르지 않습니다.', 'Pi provider별 api_key 또는 oauth 형식의 인증 파일을 지정하세요.');
const expired = () => new PiAuthError('AUTHENTICATION_EXPIRED', '인증 토큰이 만료되었거나 곧 만료됩니다.', '해당 로그인 도구로 인증을 갱신한 뒤 다시 실행하세요. CCDD는 인증 파일과 공유 Codex 토큰을 갱신하지 않습니다.');
const readonly = () => new PiAuthError('AUTHENTICATION_READ_ONLY', 'CCDD 인증 파일 연결은 읽기 전용입니다.', '해당 로그인 도구로 인증을 갱신한 뒤 다시 실행하세요.');
const inWorkspace = () => new PiAuthError('AUTHENTICATION_IN_WORKSPACE', '인증 파일을 리뷰 workspace 안에 둘 수 없습니다.', '인증 파일을 원본 repo와 복사된 workspace 밖에 두고 경로를 다시 지정하세요.');

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

export function validatePiOptions(options: PiOptions = {}): void {
  for (const value of [options.authFile, options.codexAuthFile]) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 4_096 || value.includes('\0') || !isAbsolute(value))) {
      throw new PiAuthError('AUTHENTICATION_PATH_INVALID', '인증 파일은 절대경로로 지정해야 합니다.', '--pi-auth-file 또는 --codex-auth-file에 workspace 밖 인증 파일의 절대경로를 지정하세요.');
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const sub = relative(root, candidate);
  return sub === '' || (!isAbsolute(sub) && sub !== '..' && !sub.startsWith(`..${sep}`));
}

async function canonicalPath(path: string): Promise<string> {
  let ancestor = path;
  const missing: string[] = [];
  for (;;) {
    try { return join(await realpath(ancestor), ...missing); }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw unavailable();
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
}

/** Call before snapshot creation as well as at execution: credentials must never be copied as review input. */
export async function assertPiAuthFilesOutsideWorkspace(options: PiOptions, workspacePath: string): Promise<void> {
  validatePiOptions(options);
  if (!options.authFile && !options.codexAuthFile) return;
  const root = await canonicalPath(workspacePath);
  for (const path of [options.authFile, options.codexAuthFile]) {
    if (path && isWithin(root, await canonicalPath(path))) throw inWorkspace();
  }
}

function credential(value: unknown): Credential {
  if (!object(value)) throw invalid();
  if (value.type === 'api_key') {
    if (value.key !== undefined && (typeof value.key !== 'string' || !value.key)) throw invalid();
    if (value.env !== undefined && (!object(value.env) || Object.values(value.env).some(item => typeof item !== 'string'))) throw invalid();
    if (value.key === undefined && value.env === undefined) throw invalid();
    return { type: 'api_key', ...(value.key === undefined ? {} : { key: value.key as string }), ...(value.env === undefined ? {} : { env: value.env as Record<string, string> }) };
  }
  if (value.type === 'oauth') {
    if (typeof value.access !== 'string' || !value.access || typeof value.refresh !== 'string' || !value.refresh || typeof value.expires !== 'number' || !Number.isFinite(value.expires)) throw invalid();
    if (value.expires <= Date.now() + 300_000) throw expired();
    return { ...value, type: 'oauth', access: value.access, refresh: value.refresh, expires: value.expires };
  }
  throw invalid();
}

/** Explicit credential adapters are read-only; even an expired token never enters Pi's refresh path. */
export async function createPiCredentialStore(options: PiOptions, workspacePath: string): Promise<CredentialStore> {
  validatePiOptions(options);
  const root = await realpath(workspacePath);
  async function load(path: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    try {
      const target = await realpath(path);
      if (isWithin(root, target)) throw inWorkspace();
      const info = await stat(target);
      if (!info.isFile() || info.size > 1_048_576) throw invalid();
      const data: unknown = JSON.parse(await readFile(target, { encoding: 'utf8', signal }));
      if (!object(data)) throw invalid();
      return data;
    } catch (error) {
      if (error instanceof PiAuthError) throw error;
      signal?.throwIfAborted();
      throw unavailable();
    }
  }
  async function codex(signal?: AbortSignal): Promise<Credential | undefined> {
    if (!options.codexAuthFile) return undefined;
    const data = await load(options.codexAuthFile, signal);
    if (!object(data.tokens) || typeof data.tokens.access_token !== 'string' || !data.tokens.access_token) throw invalid();
    let claims: unknown;
    try { claims = JSON.parse(Buffer.from(data.tokens.access_token.split('.')[1] ?? '', 'base64url').toString('utf8')); } catch { throw invalid(); }
    if (!object(claims) || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) throw invalid();
    const expires = claims.exp * 1_000;
    if (expires <= Date.now() + 300_000) throw expired();
    // Pi receives only access, never the shared refresh token. Refresh is rejected by this store.
    return { type: 'oauth', access: data.tokens.access_token, refresh: '', expires };
  }
  return {
    async read(providerId: string, operation: AuthOperationOptions = {}): Promise<Credential | undefined> {
      operation.signal?.throwIfAborted();
      const values = options.authFile ? await load(options.authFile, operation.signal) : {};
      const found = Object.hasOwn(values, providerId) ? values[providerId] : undefined;
      if (providerId === 'openai-codex' && options.codexAuthFile) {
        if (found !== undefined) throw new PiAuthError('AUTHENTICATION_CONFLICT', 'OpenAI Codex 인증 파일이 두 곳에 지정되어 있습니다.', 'openai-codex에는 Pi 인증 또는 읽기 전용 Codex 인증 중 하나만 지정하세요.');
        return codex(operation.signal);
      }
      return found === undefined ? undefined : credential(found);
    },
    async list(operation: AuthOperationOptions = {}): Promise<readonly CredentialInfo[]> {
      const values = options.authFile ? await load(options.authFile, operation.signal) : {};
      const result: CredentialInfo[] = [];
      for (const [providerId, entry] of Object.entries(values)) {
        if (object(entry) && (entry.type === 'api_key' || entry.type === 'oauth')) result.push({ providerId, type: entry.type });
      }
      if (options.codexAuthFile && !result.some(item => item.providerId === 'openai-codex')) result.push({ providerId: 'openai-codex', type: 'oauth' });
      return result;
    },
    async modify(): Promise<Credential | undefined> { throw readonly(); },
    async delete(): Promise<void> { throw readonly(); },
  };
}
