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

const unavailable = () => new PiAuthError('AUTHENTICATION_UNAVAILABLE', 'Cannot read the specified authentication file.', 'Check the authentication file path and read permissions. Keep the file outside the review workspace.');
const invalid = () => new PiAuthError('AUTHENTICATION_INVALID', 'The specified authentication file has an invalid format.', 'Specify a Pi authentication file with provider-specific api_key or oauth credentials.');
const expired = () => new PiAuthError('AUTHENTICATION_EXPIRED', 'The authentication token has expired or will expire soon.', 'Renew authentication with the login tool that issued it, then retry. CCDD does not refresh authentication files or shared Codex tokens.');
const readonly = () => new PiAuthError('AUTHENTICATION_READ_ONLY', 'CCDD authentication file adapters are read-only.', 'Renew authentication with the login tool that issued it, then retry.');
const inWorkspace = () => new PiAuthError('AUTHENTICATION_IN_WORKSPACE', 'Authentication files cannot be inside the review workspace.', 'Move authentication files outside the source repository and copied workspace, then update their paths.');

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

export function validatePiOptions(options: PiOptions = {}): void {
  for (const value of [options.authFile, options.codexAuthFile]) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 4_096 || value.includes('\0') || !isAbsolute(value))) {
      throw new PiAuthError('AUTHENTICATION_PATH_INVALID', 'Authentication file paths must be absolute.', 'Set --pi-auth-file or --codex-auth-file to the absolute path of an authentication file outside the workspace.');
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
        if (found !== undefined) throw new PiAuthError('AUTHENTICATION_CONFLICT', 'OpenAI Codex authentication files are configured in two places.', 'For openai-codex, configure either Pi authentication or the read-only Codex adapter.');
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
