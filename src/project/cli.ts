#!/usr/bin/env node
import { requesterRun, requesterRequest, requesterPlan, requesterEvidence, type RequesterPlan } from '../result-view.js';
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { diagnosticsMain } from '../diagnostics-cli.js';
import { createBroker, readStateContext } from '../broker/index.js';
import { createGraphDefinition } from '../broker/graph.js';
import { dependencyClosure } from '../artifacts/scope.js';
import { readWorkspaceConfig } from '../broker/config.js';
import { prepareWorkspace } from '../workspaces/index.js';
import { localContext, createLocalAlarmMethods } from '../local.js';
import { createExecutorRegistry } from '../executors/index.js';
import { ensureRunWorker } from '../worker-client.js';
import { inspectProject } from './index.js';
import { projectHistory, projectRun, projectRuns, projectRequests, type ProjectRunView } from './store.js';
import type { ProjectPlan, ProjectSelection } from './types.js';
import type { PiOptions } from '../executors/pi.js';
import { withCliCancellation } from '../cli-cancellation.js';
import { claimHumanFromCli } from '../review/local-claim.js';

type Output = { write(value: string): unknown };
const terminal = new Set(['GREEN', 'RED', 'ERROR', 'INCOMPLETE']);
const flags = new Set(['--all', '--recursive', '--force', '--wait', '--json', '--full', '--help', '--human-inbox']);
const values = new Set(['--repo', '--state-dir', '--critic', '--timeout-ms', '--requester', '--reviewer', '--result-file', '--tool', '--args', '--run', '--pi-auth-file', '--codex-auth-file', '--integrity']);
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
  ccdd-project doctor | tools check | monitor   (explicit diagnostics and UI)

Individual verification runs selected Critics immediately; missing required evidence makes the request INCOMPLETE.
--recursive includes Critics throughout the required dependency scope, including cycles.
--force reviews selected Critics again while reusing matching dependency evidence.
Queries never create review tickets, send alarms or execute review tools or Providers.
Reviews run in the supplied workspace. Keep it unchanged until completion.
State and review output must stay outside the repository.
verify/status/plan accept --integrity content|metadata (default: content).
metadata trusts unchanged filesystem metadata to reuse captured content identity;
it is opt-in, weaker than full content checks, and its evidence cannot satisfy content verification.
Common options: --repo PATH, --state-dir PATH, --json.
Results are compact by default; --full includes the audit payload. run show always includes full detail.
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
function planText(plan: RequesterPlan): string {
  const target = plan.selection.kind === 'artifact' ? plan.selection.artifactId : plan.selection.kind === 'critic' ? plan.selection.criticId : 'Project';
  // Project queries expose only the selection's required dependency closure.
  const artifacts = plan.artifacts;
  const results = new Map(plan.results.map(result => [result.reference.requestId, result]));
  return `${target}: ${plan.satisfied ? 'SATISFIED' : 'NOT SATISFIED'}\nSnapshot: ${plan.snapshotHash}\nIntegrity: ${plan.workspaceIntegrity ?? 'content'}\n` + artifacts.map(a => `  Artifact ${a.id}: ${a.status} (${a.passed}/${a.total} Critics)${a.identity ? ` · identity: ${a.identity} · value: ${a.value}` : ''}\n`).join('') + plan.items.map(c => {
    const result = c.result ? results.get(c.result.requestId) : undefined;
    return `  ${c.id}: ${c.action} · ${c.status}\n    ${c.reason}${result ? `\n    Critic reason: ${result.reason}\n    Evidence: ${result.evidence.join('; ')}\n    Reference: ${JSON.stringify(result.reference)}` : ''}`;
  }).join('\n') + `\nReuse ${plan.counts.reuse} · Ready ${plan.counts.execute} · Waiting ${plan.counts.wait} · Active ${plan.counts.active} · Failed ${plan.counts.failed}`;
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr }: { stdout?: Output; stderr?: Output } = {}): Promise<number> {
  let json = argv.includes('--json');
  let broker: ReturnType<typeof createBroker<'full'>> | undefined;
  const print = (value: unknown, plain?: string) => stdout.write((!json && plain !== undefined ? plain : JSON.stringify(value, null, 2)) + '\n');
  try {
    const command = argv[0] ?? 'help';
    if (['doctor', 'tools', 'monitor', 'prepare-demo'].includes(command)) return await diagnosticsMain(argv, { stdout, stderr });
    const { options, positional } = parse(argv.slice(1)); json = Boolean(options['--json']);
    const get = (key: string) => typeof options[key] === 'string' ? options[key] as string : undefined;
    if (['help', '--help'].includes(command) || options['--help']) { stdout.write(help); return 0; }
    if (!['status', 'plan', 'verify', 'history', 'graph', 'config', 'run', 'request'].includes(command)) throw new Error(`Unknown command: ${command}`);
    const common = ['--repo', '--state-dir', '--json'];
    const full = Boolean(options['--full']) || command === 'run' && positional[0] === 'show';
    const permitted = new Set([...common, ...(['status', 'plan', 'verify', 'history', 'run', 'request'].includes(command) ? ['--full'] : []), ...(['status', 'plan', 'verify', 'history'].includes(command) ? ['--critic', '--all'] : []),
      ...(['status', 'plan', 'verify'].includes(command) ? ['--integrity'] : []),
      ...(['plan', 'verify'].includes(command) ? ['--recursive', '--force'] : []),
      ...(command === 'verify' ? ['--wait', '--timeout-ms', '--requester', '--human-inbox', '--pi-auth-file', '--codex-auth-file'] : []),
      ...(command === 'run' ? ['--wait', '--timeout-ms'] : []),
      ...(command === 'request' ? ['--run', '--reviewer', '--result-file', '--tool', '--args'] : [])]);
    for (const key of Object.keys(options)) if (!permitted.has(key)) throw new Error(`${key} is not supported by ${command}.`);
    const workspaceIntegrity = get('--integrity') ?? 'content';
    if (workspaceIntegrity !== 'content' && workspaceIntegrity !== 'metadata') throw new Error('--integrity must be content or metadata.');
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
    const runOutput = (run: ProjectRunView) => full ? { ...run, workspaceIntegrity: run.workspace?.integrity ?? 'content' } : requesterRun(run, context.stateDir);
    const printRun = (run: ProjectRunView) => print(runOutput(run), full ? undefined : `Run: ${run.id}\nExecution: ${run.status}\nIntegrity: ${run.workspace?.integrity ?? 'content'}${run.validation ? `\n${planText(requesterPlan(run.validation, context.stateDir))}` : ''}`);
    const wait = async (id: string): Promise<number> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const run = projectRun(context.stateDir, id);
        if (!run) throw new Error('Review handle not found.');
        if (terminal.has(run.status)) { printRun(run); return exitFor(run); }
        if (Date.now() >= deadline) { print({ ...runOutput(run), wait: { completed: false, reason: 'timeout' } }, `Run ${id}: waiting timed out; execution continues.`); return 3; }
        await delay(Math.min(100, Math.max(1, deadline - Date.now())));
      }
    };
    if (command === 'config' || command === 'graph') {
      if (command === 'config' && (positional.length !== 1 || positional[0] !== 'check')) throw new Error('Use config check.');
      const selection = command === 'config' ? { kind: 'all' } as const : select();
      const workspace = await prepareWorkspace({ ...context, integrity: workspaceIntegrity });
      try {
        const { config } = await readWorkspaceConfig(workspace.descriptor.path, workspace.signal);
        await workspace.assertUnchanged();
        if (command === 'config') { print({ ok: true, artifacts: Object.keys(config.artifacts).length, critics: config.critics.length, snapshotHash: workspace.descriptor.hash }, 'Folder configuration and Artifact references are valid.'); return 0; }
        const graph = createGraphDefinition(config);
        if (selection.kind !== 'all') {
          const target = selection.kind === 'artifact' ? selection.artifactId : config.critics.find(c => c.id === selection.criticId)?.target;
          if (!target || !Object.hasOwn(config.artifacts, target)) throw new Error(selection.kind === 'artifact' ? `Unknown Artifact: ${selection.artifactId}` : `Unknown Critic: ${selection.criticId}`);
          const artifacts = new Set(dependencyClosure(config.relations, [target]));
          graph.critics = graph.critics.filter(c => artifacts.has(c.target));
          graph.artifacts = Object.fromEntries(Object.entries(graph.artifacts).filter(([id]) => artifacts.has(id)));
          graph.relations = graph.relations.filter(edge => artifacts.has(edge.source) && artifacts.has(edge.target));
        }
        print(graph, graph.critics.map(c => `${c.id}: ${c.deps.join(', ') || '(no deps)'} -> ${c.target}`).join('\n') || Object.keys(graph.artifacts).join('\n')); return 0;
      } finally { await workspace.close(); }
    }
    if (command === 'status' || command === 'plan') {
      const selection = select(command === 'plan');
      const { plan } = await withCliCancellation('Project validation cancelled.', signal => inspectProject({ detail: 'full', ...context, selection, recursive: Boolean(options['--recursive']), force: Boolean(options['--force']), workspaceIntegrity, signal }));
      const output = full ? plan : requesterPlan(plan, context.stateDir);
      print(output, full ? undefined : planText(requesterPlan(plan, context.stateDir))); return command === 'plan' || plan.satisfied ? 0 : 1;
    }
    if (command === 'history') {
      const selection = select();
      const entries = projectHistory(context.stateDir, { detail: 'full' }).filter(e => selection.kind === 'all' || selection.kind === 'critic' && e.criticId === selection.criticId || selection.kind === 'artifact' && e.input.target.id === selection.artifactId);
      print(full ? entries : entries.map(e => requesterEvidence(e, context.stateDir)), full ? undefined : entries.map(e => `${e.completedAt} ${e.criticId} ${e.verdict} · ${e.requestId}\n  ${e.summary}`).join('\n') || 'No recorded validation evidence.'); return 0;
    }
    if (command === 'run' || command === 'request') {
      const [action, id] = positional;
      const actions = command === 'run' ? ['list', 'show', 'resume', 'cancel'] : ['list', 'show', 'claim', 'tool', 'submit'];
      if (!actions.includes(action) || positional.length !== (action === 'list' ? 1 : 2)) throw new Error(`Use ${command} ${actions.join('|')} with the appropriate ID.`);
      if (command === 'run' && options['--wait'] && !['show', 'resume'].includes(action)) throw new Error('--wait requires run show or run resume.');
      if (action === 'list') { print(command === 'run' ? projectRuns(context.stateDir, { detail: full ? 'full' : 'compact' }) : projectRequests(context.stateDir, get('--run'), { detail: full ? 'full' : 'compact' })); return 0; }
      if (action === 'show') {
        if (command === 'run') { if (options['--wait']) return await wait(id); const run = projectRun(context.stateDir, id); if (!run) throw new Error('Review handle not found.'); printRun(run); }
        else { const request = projectRequests(context.stateDir, undefined, { detail: 'full' }).find(r => r.id === id); if (!request) throw new Error('Review request not found.'); print(full ? request : requesterRequest(request, context.stateDir)); }
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
    broker = createBroker({ detail: 'full', ...context, executors, workspaceIntegrity });
    if (command === 'verify') {
      const run = await withCliCancellation('Project validation cancelled.', signal => broker!.submitProject({ selection: verifySelection!, recursive: Boolean(options['--recursive']), force: Boolean(options['--force']), requesterId: get('--requester') ?? 'cli', signal }));
      if (!terminal.has(run.status)) await ensureRunWorker({ broker, context, run, initialConfig: { piOptions, humanInbox } });
      if (options['--wait']) return await wait(run.id);
      const view = projectRun(context.stateDir, run.id)!; printRun(view);
      return view.status === 'INCOMPLETE' ? 4 : view.status === 'ERROR' ? 2 : 0;
    }
    const [action, id] = positional;
    if (command === 'run') {
      let run = broker.getRun(id); if (!run) throw new Error('Review handle not found.');
      if (action === 'resume' && run.project?.version !== 3) throw new Error('Historical Runs cannot be resumed; submit a new validation request.');
      if (action === 'cancel') run = broker.cancel(id);
      else if (action === 'resume' && !terminal.has(run.status)) run = await ensureRunWorker({ broker, context, run });
      if (options['--wait']) return await wait(id);
      printRun(projectRun(context.stateDir, id)!); return 0;
    }
    const reviewerId = get('--reviewer'); if (!reviewerId) throw new Error('--reviewer is required for Human actions.');
    const request = broker.getRequest(id); if (!request) throw new Error('Review request not found.');
    if (action === 'claim') { const claimed = await claimHumanFromCli(broker, id, reviewerId, stderr); print(full ? claimed : requesterRequest(claimed, context.stateDir)); }
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
