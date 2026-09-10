import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { readStateContext } from '../broker/index.js';
import { startReviewServer } from './server.js';
import { claimRemoteReview, executeRemoteHumanTool, listRemoteReviews, submitRemoteHumanReview, type RemoteReviewOptions } from './client.js';

type Output = { write(value: string): unknown };
const help = `Remote Human review

  ccdd-project review serve --state-dir PATH --credentials-file PATH [--host HOST] [--port PORT]
  ccdd-project review list --server URL --token-file PATH [--limit N] [--offset N]
  ccdd-project review claim REQUEST_ID --server URL --token-file PATH [--cache-dir PATH]
  ccdd-project review tool REQUEST_ID --tool NAME [--args JSON] --server URL --token-file PATH
  ccdd-project review submit REQUEST_ID --result-file PATH --server URL --token-file PATH

Claim reserves the request while downloading its fixed snapshot and checking the
local environment. Failed preparation releases the reservation and keeps cached files.
Tools run on this computer. Verdicts are submitted to the original Broker.
Client state defaults to ~/.local/state/ccdd-reviewer; override with --cache-dir.
The server credentials file maps reviewer IDs to distinct random base64url tokens
(at least 32 characters). Each client token file contains only its own token.
Keep credential files outside reviewed projects. Use HTTPS or an authenticated
tunnel when accessing a server across an untrusted network. The local monitor
continues to listen only on loopback.
`;

function parse(argv: string[]) {
  const options: Record<string, string> = {}, positional: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    if (Object.hasOwn(options, arg)) throw new Error(`Duplicate option: ${arg}`);
    if (arg === '--help' || arg === '--json') { options[arg] = 'true'; continue; }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
    options[arg] = value;
  }
  return { options, positional };
}
async function credentialFile(filename: string, source?: string): Promise<string> {
  const absolute = await realpath(resolve(filename));
  if (source) {
    const scope = relative(source, absolute);
    if (!scope || !scope.startsWith('..') && !isAbsolute(scope)) throw new Error('Reviewer credentials must stay outside the reviewed project.');
  }
  const value = await readFile(absolute, 'utf8');
  if (Buffer.byteLength(value) > 65536) throw new Error('Credential file exceeds 64 KiB.');
  return value;
}

export async function reviewMain(argv: string[], { stdout = process.stdout, stderr = process.stderr }: { stdout?: Output; stderr?: Output } = {}): Promise<number> {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Review action cancelled.'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const { options, positional } = parse(argv), [action, id] = positional;
    if (!action || action === 'help' || options['--help']) { stdout.write(help); return 0; }
    if (!['serve', 'list', 'claim', 'tool', 'submit'].includes(action)) throw new Error('Use review serve, list, claim, tool, or submit.');
    if (positional.length !== (['claim', 'tool', 'submit'].includes(action) ? 2 : 1)) throw new Error('Unexpected review command arguments.');
    const allowed = new Set(['--json', ...(action === 'serve' ? ['--state-dir', '--credentials-file', '--host', '--port'] : ['--server', '--token-file', '--cache-dir']),
      ...(action === 'list' ? ['--limit', '--offset'] : []), ...(action === 'tool' ? ['--tool', '--args'] : []), ...(action === 'submit' ? ['--result-file'] : [])]);
    for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error(`${key} is not supported by review ${action}.`);
    const required = (key: string) => { if (!options[key]) throw new Error(`${key} is required.`); return options[key]; };
    if (action === 'serve') {
      const context = readStateContext(resolve(required('--state-dir')));
      const reviewers = JSON.parse(await credentialFile(required('--credentials-file'), context.repoPath)) as Record<string, string>;
      const server = await startReviewServer({ stateDir: context.stateDir, reviewers, host: options['--host'], port: options['--port'] === undefined ? undefined : Number(options['--port']) });
      try {
        stdout.write(JSON.stringify({ url: server.url }) + '\n');
        if (!controller.signal.aborted) await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
      } finally { await server.close(); }
      return 0;
    }
    let phase = '';
    const client: RemoteReviewOptions = { server: required('--server'), token: (await credentialFile(required('--token-file'))).trim(),
      stateDir: resolve(options['--cache-dir'] ?? join(homedir(), '.local', 'state', 'ccdd-reviewer')), signal: controller.signal,
      onProgress: event => {
        if (options['--json'] || event.phase === phase) return;
        phase = event.phase;
        stderr.write(event.phase === 'download' ? 'Try Claim: preparing the snapshot and downloading missing files.\n' : event.phase === 'environment' ? 'Try Claim: checking the local review environment.\n' : 'Claim confirmed.\n');
      },
    };
    let result: unknown;
    if (action === 'list') result = await listRemoteReviews(client, { limit: options['--limit'] === undefined ? undefined : Number(options['--limit']), offset: options['--offset'] === undefined ? undefined : Number(options['--offset']) });
    else if (action === 'claim') result = await claimRemoteReview(id, client);
    else if (action === 'tool') result = await executeRemoteHumanTool(id, required('--tool'), JSON.parse(options['--args'] ?? '{}'), client);
    else {
      const content = await readFile(resolve(required('--result-file')), 'utf8');
      if (Buffer.byteLength(content) > 64 * 1024) throw new Error('Result file exceeds 64 KiB.');
      result = await submitRemoteHumanReview(id, JSON.parse(content), client);
    }
    stdout.write(JSON.stringify(result, null, 2) + '\n'); return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (argv.includes('--json')) stdout.write(JSON.stringify({ error: message }) + '\n'); else stderr.write(message + '\n');
    return 2;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}
