#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { main as legacyMain } from '../cli.js';
import { createBroker, readStateContext } from '../broker/index.js';
import { createGraphDefinition } from '../broker/graph.js';
import { includedCritics } from './query.js';
import { isArtifactGroup } from '../artifacts/groups.js';
import { localContext, createLocalAlarmMethods } from '../local.js';
import { createExecutorRegistry } from '../executors/index.js';
import { ensureRunWorker } from '../worker-client.js';
import { inspectProject } from './index.js';
import { projectHistory, projectRun, projectRuns, projectRequests, type ProjectRunView } from './store.js';
import type { ProjectPlan, ProjectSelection } from './types.js';
import type { PiOptions } from '../executors/pi.js';
import { reviewMain } from '../review/cli.js';

type Output = { write(value: string): unknown };
const terminal = new Set(['GREEN', 'RED', 'ERROR', 'INCOMPLETE']);
const flags = new Set(['--all', '--recursive', '--force', '--wait', '--json', '--help', '--copy', '--lock', '--human-inbox']);
const values = new Set(['--repo', '--state-dir', '--critic', '--timeout-ms', '--requester', '--reviewer', '--result-file', '--tool', '--args', '--run', '--pi-auth-file', '--codex-auth-file']);
const help = `CCDD Project — pull validation and explicit review execution

  ccdd-project status [ARTIFACT | --critic ID] [--json]
  ccdd-project plan (ARTIFACT | --critic ID | --all) [--recursive] [--force]
  ccdd-project verify (ARTIFACT | --critic ID | --all) [--recursive] [--force] [--wait]
  ccdd-project history [ARTIFACT | --critic ID]
  ccdd-project graph [ARTIFACT]
  ccdd-project config check
  ccdd-project run list
  ccdd-project run show RUN_ID [--wait]
  ccdd-project run resume RUN_ID [--wait]
  ccdd-project run cancel RUN_ID
  ccdd-project request list [--run RUN_ID]
  ccdd-project request show REQUEST_ID
  ccdd-project request claim REQUEST_ID --reviewer ID
  ccdd-project request tool REQUEST_ID --reviewer ID --tool NAME --args JSON
  ccdd-project request submit REQUEST_ID --reviewer ID --result-file PATH
  ccdd-project review serve | list | claim | tool | submit   (remote Human review)
  ccdd-project doctor | tools check | monitor   (existing diagnostics and UI)

Individual verification runs ready selected Critics and reports blocked Critics as incomplete.
--recursive includes required ancestors; direct Critic selection never bypasses dependencies.
--force reviews selected Critics again, keeping dependency gates and ancestor reuse.
Queries never create review tickets, send alarms or execute review tools or Providers.
verify defaults to --copy; --lock is explicit. State must be outside the repository.
Common options: --repo PATH, --state-dir PATH, --json.
Execution: --human-inbox, --pi-auth-file PATH, --codex-auth-file PATH.
--wait: 0=fulfilled, 1=RED, 2=ERROR, 3=timeout, 4=incomplete. Timeout does not cancel.
Without --wait, 0 means accepted or already fulfilled; inspect the reported outcome.
`;

function parse(argv: string[]) {
  const options: Record<string, string | boolean> = {}, positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flags.has(arg) || values.has(arg)) {
      if (options[arg] !== undefined) throw new Error(`Duplicate option: ${arg}`);
      if (flags.has(arg)) options[arg] = true;
      else { const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`); options[arg] = value; }
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  return { options, positional };
}

const exitFor = (run: ProjectRunView) => run.status === 'GREEN' ? 0 : run.status === 'RED' ? 1 : run.status === 'INCOMPLETE' ? 4 : 2;
const publicRun = ({ project, ...run }: ProjectRunView) => run;
function planText(plan: ProjectPlan): string {
  const target = plan.selection.kind === 'artifact' ? plan.selection.artifactId : plan.selection.kind === 'critic' ? plan.selection.criticId : 'Project';
  const artifacts = plan.artifacts.filter(a => plan.selection.kind === 'all' || plan.selection.kind === 'artifact' && a.id === plan.selection.artifactId);
  return `${target}: ${plan.satisfied ? 'SATISFIED' : 'NOT SATISFIED'}\nSnapshot: ${plan.snapshotHash}\n` + artifacts.map(a => `  Artifact ${a.id}: ${a.status} (${a.passed}/${a.total} Critics)\n`).join('') + plan.items.map(c => `  ${c.id}: ${c.action} · ${c.status}\n    ${c.reason}`).join('\n') +
    `\nReuse ${plan.counts.reuse} · Ready ${plan.counts.execute} · Waiting ${plan.counts.wait} · Active ${plan.counts.active} · Failed ${plan.counts.failed}`;
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr }: { stdout?: Output; stderr?: Output } = {}): Promise<number> {
  let json = argv.includes('--json');
  let broker: ReturnType<typeof createBroker> | undefined;
  const print = (value: unknown, plain?: string) => stdout.write((!json && plain !== undefined ? plain : JSON.stringify(value, null, 2)) + '\n');
  try {
    const command = argv[0] ?? 'help';
    if (command === 'review') return await reviewMain(argv.slice(1), { stdout, stderr });
    if (['doctor', 'tools', 'monitor'].includes(command)) return await legacyMain(argv, { stdout, stderr });
    const { options, positional } = parse(argv.slice(1)); json = Boolean(options['--json']);
    const get = (key: string) => typeof options[key] === 'string' ? options[key] as string : undefined;
    if (['help', '--help'].includes(command) || options['--help']) { stdout.write(help); return 0; }
    if (!['status', 'plan', 'verify', 'history', 'graph', 'config', 'run', 'request'].includes(command)) throw new Error(`Unknown command: ${command}`);
    const common = ['--repo', '--state-dir', '--json'];
    const permitted = new Set([...common, ...(['status', 'plan', 'verify', 'history'].includes(command) ? ['--critic', '--all'] : []),
      ...(['plan', 'verify'].includes(command) ? ['--recursive', '--force'] : []),
      ...(command === 'verify' ? ['--wait', '--timeout-ms', '--requester', '--human-inbox', '--pi-auth-file', '--codex-auth-file', '--copy', '--lock'] : []),
      ...(command === 'run' ? ['--wait', '--timeout-ms'] : []),
      ...(command === 'request' ? ['--run', '--reviewer', '--result-file', '--tool', '--args'] : [])]);
    for (const key of Object.keys(options)) if (!permitted.has(key)) throw new Error(`${key} is not supported by ${command}.`);
    if (options['--copy'] && options['--lock']) throw new Error('--copy and --lock are mutually exclusive.');
    const timeoutMs = Number(get('--timeout-ms') ?? 600000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000) throw new Error('--timeout-ms must be between 1 and 86400000.');
    let context;
    const requestedState = get('--state-dir');
    if (requestedState && existsSync(join(resolve(requestedState), 'broker.sqlite'))) {
      context = readStateContext(resolve(requestedState));
      if (get('--repo') && realpathSync(resolve(get('--repo')!)) !== context.repoPath) throw new Error('State directory belongs to a different repository.');
    } else {
      context = await localContext({ repoPath: resolve(get('--repo') ?? process.cwd()), stateDir: requestedState });
      if (existsSync(join(context.stateDir, 'broker.sqlite'))) {
        const stored = readStateContext(context.stateDir);
        if (stored.repoPath !== context.repoPath) throw new Error('State directory belongs to a different repository.');
        context = stored;
      }
    }
    const select = (required = false): ProjectSelection => {
      if (positional.length > 1 || Number(Boolean(positional[0])) + Number(Boolean(get('--critic'))) + Number(Boolean(options['--all'])) > 1) throw new Error('Choose one Artifact, --critic ID, or --all.');
      if (positional[0]) return { kind: 'artifact', artifactId: positional[0] };
      if (get('--critic')) return { kind: 'critic', criticId: get('--critic')! };
      if (required && !options['--all']) throw new Error('An Artifact, --critic ID, or --all is required.');
      return { kind: 'all' };
    };
    const verifySelection = command === 'verify' ? select(true) : undefined;
    const printRun = (run: ProjectRunView) => print(publicRun(run), `Run: ${run.id}\nExecution: ${run.status}${run.validation ? `\n${planText(run.validation)}` : ''}`);
    const wait = async (id: string): Promise<number> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const run = projectRun(context.stateDir, id);
        if (!run) throw new Error('Review handle not found.');
        if (terminal.has(run.status)) { printRun(run); return exitFor(run); }
        if (Date.now() >= deadline) { print({ ...publicRun(run), wait: { completed: false, reason: 'timeout' } }, `Run ${id}: waiting timed out; execution continues.`); return 3; }
        await delay(Math.min(100, Math.max(1, deadline - Date.now())));
      }
    };
    if (['status', 'plan', 'graph', 'config'].includes(command)) {
      if (command === 'config' && (positional.length !== 1 || positional[0] !== 'check')) throw new Error('Use config check.');
      const selection = command === 'config' ? { kind: 'all' } as const : select(command === 'plan');
      const { snapshot, plan } = await inspectProject({ ...context, selection, recursive: Boolean(options['--recursive']), force: Boolean(options['--force']) });
      if (command === 'config') { print({ ok: true, artifacts: Object.keys(snapshot.config.artifacts).length, critics: snapshot.config.critics.length, snapshotHash: snapshot.snapshotHash }, 'Configuration and Artifact DAG are valid.'); return 0; }
      if (command === 'graph') {
        const graph = createGraphDefinition(snapshot.config);
        if (selection.kind !== 'all') {
          const ids = new Set(includedCritics(snapshot, selection, true));
          graph.critics = graph.critics.filter(c => ids.has(c.id));
          const artifacts = new Set(selection.kind === 'artifact' ? [selection.artifactId] : []);
          const include = (id: string): void => { artifacts.add(id); const entry = graph.artifacts[id]; if (isArtifactGroup(entry)) for (const member of entry.members) if (!artifacts.has(member)) include(member); };
          for (const c of graph.critics) for (const id of [c.target, ...c.deps]) include(id);
          for (const id of [...artifacts]) include(id);
          graph.artifacts = Object.fromEntries(Object.entries(graph.artifacts).filter(([id]) => artifacts.has(id)));
        }
        print(graph, graph.critics.map(c => `${c.id}: ${c.deps.join(', ') || '(no deps)'} -> ${c.target}`).join('\n') || Object.keys(graph.artifacts).join('\n')); return 0;
      }
      print(plan, planText(plan)); return command === 'plan' || plan.satisfied ? 0 : 1;
    }
    if (command === 'history') {
      const selection = select();
      const entries = projectHistory(context.stateDir).filter(e => selection.kind === 'all' || selection.kind === 'critic' && e.criticId === selection.criticId || selection.kind === 'artifact' && e.input.target.id === selection.artifactId);
      print(entries, entries.map(e => `${e.completedAt} ${e.criticId} ${e.verdict} · ${e.requestId}\n  ${e.summary}`).join('\n') || 'No recorded validation evidence.'); return 0;
    }
    if (command === 'run' || command === 'request') {
      const [action, id] = positional;
      const actions = command === 'run' ? ['list', 'show', 'resume', 'cancel'] : ['list', 'show', 'claim', 'tool', 'submit'];
      if (!actions.includes(action) || positional.length !== (action === 'list' ? 1 : 2)) throw new Error(`Use ${command} ${actions.join('|')} with the appropriate ID.`);
      if (command === 'run' && options['--wait'] && !['show', 'resume'].includes(action)) throw new Error('--wait requires run show or run resume.');
      if (action === 'list') { print(command === 'run' ? projectRuns(context.stateDir).map(publicRun) : projectRequests(context.stateDir, get('--run'))); return 0; }
      if (action === 'show') {
        if (command === 'run') { if (options['--wait']) return await wait(id); const run = projectRun(context.stateDir, id); if (!run) throw new Error('Review handle not found.'); printRun(run); }
        else { const request = projectRequests(context.stateDir).find(r => r.id === id); if (!request) throw new Error('Review request not found.'); print(request); }
        return 0;
      }
    }
    const piOptions: PiOptions = {};
    const piFile = get('--pi-auth-file') ?? process.env.CCDD_PI_AUTH_FILE;
    const codexFile = get('--codex-auth-file') ?? process.env.CCDD_CODEX_AUTH_FILE;
    if (piFile) piOptions.authFile = resolve(piFile);
    if (codexFile) piOptions.codexAuthFile = resolve(codexFile);
    const humanInbox = Boolean(options['--human-inbox']);
    const executors = createExecutorRegistry({ piOptions, alarmMethods: createLocalAlarmMethods({ ...context, humanInbox }) });
    broker = createBroker({ ...context, executors });
    if (command === 'verify') {
      const run = await broker.submitProject({ selection: verifySelection!, recursive: Boolean(options['--recursive']), force: Boolean(options['--force']), requesterId: get('--requester') ?? 'cli', mode: options['--lock'] ? 'lock' : 'copy' });
      if (!terminal.has(run.status)) await ensureRunWorker({ broker, context, run, initialConfig: { piOptions, humanInbox } });
      if (options['--wait']) return await wait(run.id);
      const view = projectRun(context.stateDir, run.id)!; printRun(view);
      return view.status === 'INCOMPLETE' ? 4 : view.status === 'ERROR' ? 2 : 0;
    }
    const [action, id] = positional;
    if (command === 'run') {
      let run = broker.getRun(id); if (!run) throw new Error('Review handle not found.');
      if (action === 'cancel') run = broker.cancel(id);
      else if (action === 'resume' && !terminal.has(run.status)) run = await ensureRunWorker({ broker, context, run });
      if (options['--wait']) return await wait(id);
      printRun(projectRun(context.stateDir, id)!); return 0;
    }
    const reviewerId = get('--reviewer'); if (!reviewerId) throw new Error('--reviewer is required for Human actions.');
    const request = broker.getRequest(id); if (!request) throw new Error('Review request not found.');
    if (action === 'claim') print(await broker.claimHuman(id, reviewerId));
    else if (action === 'tool') {
      const toolName = get('--tool'); if (!toolName) throw new Error('--tool is required.');
      print(await broker.executeHumanTool(id, { reviewerId, toolName, arguments: JSON.parse(get('--args') ?? '{}') }));
    } else {
      const filename = get('--result-file'); if (!filename) throw new Error('--result-file is required.');
      const content = await readFile(resolve(filename), 'utf8'); if (Buffer.byteLength(content) > 256000) throw new Error('Human result file is too large.');
      await broker.completeHuman(id, { reviewerId, result: JSON.parse(content) });
      const run = broker.getRun(request.runId)!;
      if (run.status === 'QUEUED') await ensureRunWorker({ broker, context, run });
      printRun(projectRun(context.stateDir, request.runId)!);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) print({ error: message }); else stderr.write(message + '\n');
    return 2;
  } finally { await broker?.close(); }
}

let entrypoint = false;
try { entrypoint = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (entrypoint) process.exitCode = await main();
