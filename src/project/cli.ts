#!/usr/bin/env node
import { providerStatus, resumeProvider } from '../executors/provider-coordinator.js';
import { streamProjectResults, projectRunSummary, projectRequestSummary, compareProjectRuns } from './results.js';
import { once } from 'node:events';
import { cacheCommand } from '../cache/cli.js';
import { rejectIdentityConcurrency, validateMaxExecutions } from '../resources.js';
import { readSelectionFile } from './selection-file.js';
import { loadCheck } from './load-check.js';
import { requiredArtifacts } from './query.js';
import { positiveConcurrency } from './identity.js';
import { requesterRun, requesterRequest, requesterPlan, requesterEvidence, type RequesterPlan } from '../result-view.js';
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { diagnosticsMain } from '../diagnostics-cli.js';
import { createBroker, readStateContext } from '../broker/index.js';
import { compactGraphDefinition, createGraphDefinition } from '../broker/graph.js';
import { dependencyClosure } from '../artifacts/scope.js';
import { readWorkspaceConfig } from '../broker/config.js';
import { prepareWorkspace } from '../workspaces/index.js';
import { localContext, createLocalAlarmMethods } from '../local.js';
import { createExecutorRegistry } from '../executors/index.js';
import { ensureRunWorker } from '../worker-client.js';
import { pruneProject } from './prune.js';
import { inspectProject } from './index.js';
import { evidenceFamilies, projectHistory, projectRun, projectRuns, projectRequests, type ProjectRunView } from './store.js';
import type { ProjectPlan, ProjectSelection } from './types.js';
import type { PiOptions } from '../executors/pi.js';
import { withCliCancellation } from '../cli-cancellation.js';
import { claimHumanFromCli } from '../review/local-claim.js';

type Output = { write(value: string): unknown };
const terminal = new Set(['GREEN', 'RED', 'ERROR', 'INCOMPLETE']);
const flags = new Set(['--stream','--compact', '--all', '--recursive', '--force', '--ignore-gates', '--wait', '--json', '--full', '--help', '--human-inbox']);
const values = new Set(['--after','--profile', '--repo', '--state-dir', '--critic', '--timeout-ms', '--requester', '--reviewer', '--result-file', '--tool', '--args', '--run', '--pi-auth-file', '--codex-auth-file', '--integrity', '--concurrency', '--identity-concurrency', '--max-executions', '--requests', '--output-dir', '--critics', '--artifacts', '--critics-file', '--artifacts-file', '--scenario-file', '--processes', '--resource-mode']);
const help = `CCDD Project — pull validation and explicit review execution

  ccdd-project cache show ID | list | compare LEFT RIGHT | gc | delete ID [--cache-dir PATH] [--json]
  ccdd-project load-check [--concurrency 60] [--requests 60] [--output-dir PATH] [--json]
  ccdd-project status [ARTIFACT | --critic ID] [--json]
  ccdd-project plan (ARTIFACT | --critic ID | --all) [--recursive] [--force]
  ccdd-project verify (ARTIFACT | --critic ID | --all) [--recursive] [--force] [--wait]
  ccdd-project prune --state-dir PATH
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

Dependency Critics must have current GREEN evidence before execution. RED blocks descendants; operational failures wait. SCC peers execute together.
--recursive includes Critics throughout the required dependency scope, including cycles.
--force reviews selected Critics again while respecting dependency gates.
--ignore-gates explicitly evaluates selected Critics regardless of dependency verdicts.
Queries never create review tickets, send alarms or execute review tools or Providers.
Reviews run in the supplied workspace. Keep it unchanged until completion.
State and review output must stay outside the repository.
provider status|resume NAME inspects cooldowns or resumes after account intervention.
verify --stream emits terminal NDJSON results; run stream ID --after N resumes a subscription.
run summary ID, request summary ID and run diff LEFT RIGHT are read-only queries.
--force bypasses caching for one execution and never replaces a shared result.
verify accepts --max-executions N (durable submission starts; 0 means reuse-only).
verify accepts optional --concurrency N as a tighter cap; it never raises machine capacity.
Identity scheduling uses local resources.json identityCapacity and Artifact stale.weight.
verify/status/plan accept --integrity content|metadata (default: content).
metadata trusts unchanged filesystem metadata to reuse captured content identity;
it is opt-in and weaker than full content checks; it is not part of an identity cache key.
Graph: graph --compact --json omits per-instance view definitions.
Selection: --critics-file PATH or --artifacts-file PATH (JSON array or one ID per line).
File selections cannot be combined with other selectors. Families are Artifact selectors.
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

const exitFor = (run: ProjectRunView) => run.publication && run.publication.state !== 'accepted' ? 2 : run.status === 'GREEN' ? 0 : run.status === 'RED' ? 1 : run.status === 'INCOMPLETE' ? 4 : 2;
function planText(plan: RequesterPlan): string {
  const target = plan.selection.kind === 'artifact' ? plan.selection.artifactId : plan.selection.kind === 'critic' ? plan.selection.criticId : 'Project';
  // Project queries expose only the selection's required dependency closure.
  const artifacts = plan.artifacts;
  const results = new Map(plan.results.map(result => [result.reference.requestId, result]));
  return `${target}: ${plan.satisfied ? 'SATISFIED' : 'NOT SATISFIED'}\nSnapshot: ${plan.snapshotHash}\nIntegrity: ${plan.workspaceIntegrity ?? 'content'}\n` + artifacts.map(a => `  Artifact ${a.id}: ${a.status} (${a.passed}/${a.total} Critics)${a.identity ? ` · identity: ${a.identity} · value: ${a.value}` : ''}\n`).join('') + plan.items.map(c => {
    const result = c.result ? results.get(c.result.requestId) : undefined;
    return `  ${c.id}: ${c.action} · ${c.status}\n    ${c.reason}${c.action === 'COALESCE' ? `\n    Request: ${c.requestId}${c.leaseExpiresAt ? ` · Lease expires: ${c.leaseExpiresAt}` : ''}` : ''}${result ? `\n    Result: ${JSON.stringify(result)}\n    Reference: ${JSON.stringify(result.reference)}` : ''}`;
  }).join('\n') + `\nReuse ${plan.counts.reuse} · Coalesce ${plan.counts.coalesce} · Gated ${plan.counts.gated} · Ready ${plan.counts.execute} · Waiting ${plan.counts.wait} · Active ${plan.counts.active} · Failed ${plan.counts.failed}`;
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr }: { stdout?: Output; stderr?: Output } = {}): Promise<number> {
  let json = argv.includes('--json');
  let broker: ReturnType<typeof createBroker<'full'>> | undefined;
  const print = (value: unknown, plain?: string) => stdout.write((!json && plain !== undefined ? plain : JSON.stringify(value, null, 2)) + '\n');
  try {
    const command = argv[0] ?? 'help';
    if (command === 'provider') {
      const parts = argv.slice(1).filter(part => part !== '--json');
      if (parts.length === 1 && parts[0] === 'status') { print(providerStatus()); return 0; }
      if (parts.length === 2 && parts[0] === 'resume') { print({ provider: parts[1], resumed: resumeProvider(parts[1]) }); return 0; }
      throw new Error('Use provider status or provider resume NAME.');
    }
    if (command === 'cache') return await cacheCommand(argv.slice(1), stdout);
    if (['doctor', 'tools', 'monitor', 'prepare-demo'].includes(command)) return await diagnosticsMain(argv, { stdout, stderr });
    const { options, positional } = parse(argv.slice(1)); json = Boolean(options['--json']);
    const get = (key: string) => typeof options[key] === 'string' ? options[key] as string : undefined;
    if (['help', '--help'].includes(command) || options['--help']) { stdout.write(help); return 0; }
    if (command === 'load-check') {
      for (const key of Object.keys(options)) if (!['--concurrency', '--requests', '--output-dir', '--json', '--repo', '--scenario-file', '--processes', '--resource-mode'].includes(key)) throw new Error(`${key} is not supported by load-check.`);
      const scenarioFile = get('--scenario-file');
      if (get('--repo') && !scenarioFile) throw new Error('Real-project load-check requires --scenario-file (selection, recursive, ignoreGates, scenario).');
      const project = scenarioFile ? { ...JSON.parse(await readFile(resolve(scenarioFile), 'utf8')), repoPath: resolve(get('--repo') ?? process.cwd()) } : undefined;
      const report = await withCliCancellation('Offline load check cancelled.', signal => loadCheck({ concurrency: get('--concurrency') === undefined ? undefined : Number(get('--concurrency')), requests: get('--requests') === undefined ? undefined : Number(get('--requests')), processes: get('--processes') === undefined ? undefined : Number(get('--processes')), resourceMode: get('--resource-mode') as 'isolated' | 'shared' | undefined, project, outputDir: get('--output-dir'), signal }));
      print(report); return report.status === 'GREEN' ? 0 : 2;
    }
    if (!['status', 'plan', 'verify', 'history', 'graph', 'config', 'run', 'request', 'prune'].includes(command)) throw new Error(`Unknown command: ${command}`);
    const common = ['--repo', '--state-dir', '--json'];
    const full = Boolean(options['--full']) || command === 'run' && positional[0] === 'show';
    const permitted = new Set([...common, ...(['status', 'plan', 'verify', 'history', 'run', 'request'].includes(command) ? ['--full'] : []), ...(['status', 'plan', 'verify', 'history'].includes(command) ? ['--critic', '--critics', '--artifacts', '--critics-file', '--artifacts-file', '--all'] : []),
      ...(['status', 'plan', 'verify'].includes(command) ? ['--integrity', '--identity-concurrency', '--profile'] : []),
      ...(['plan', 'verify'].includes(command) ? ['--recursive', '--force', '--ignore-gates'] : []),
      ...(command === 'verify' ? ['--stream', '--max-executions', '--concurrency', '--wait', '--timeout-ms', '--requester', '--human-inbox', '--pi-auth-file', '--codex-auth-file'] : []),
      ...(command === 'run' ? ['--after', '--wait', '--timeout-ms'] : []),
      ...(command === 'graph' ? ['--compact'] : []),
      ...(command === 'request' ? ['--run', '--reviewer', '--result-file', '--tool', '--args'] : [])]);
    for (const key of Object.keys(options)) if (!permitted.has(key)) throw new Error(`${key} is not supported by ${command}.`);
    const maxConcurrentExecutors = get('--concurrency') === undefined ? undefined : positiveConcurrency(Number(get('--concurrency')), '--concurrency');
    const maxExecutions = get('--max-executions') === undefined ? undefined : Number(get('--max-executions')); validateMaxExecutions(maxExecutions);
    rejectIdentityConcurrency(get('--identity-concurrency'));
    const identityConcurrency = undefined;
    const workspaceIntegrity = get('--integrity') ?? 'content';
    if (workspaceIntegrity !== 'content' && workspaceIntegrity !== 'metadata') throw new Error('--integrity must be content or metadata.');
    const timeoutMs = Number(get('--timeout-ms') ?? 600000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error('--timeout-ms must be between 1 and 2147483647.');
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
    if (command === 'prune') {
      if (positional.length) throw new Error('prune does not accept positional arguments.');
      const result = pruneProject(context.stateDir);
      print(result, `Removed ${result.removed.length} transient paths; skipped ${result.skippedRequests.length} active or owned requests. Audit evidence is preserved.`);
      return 0;
    }
    const fileCritics = get('--critics-file') ? await readSelectionFile(resolve(get('--critics-file')!)) : undefined;
    const fileArtifacts = get('--artifacts-file') ? await readSelectionFile(resolve(get('--artifacts-file')!)) : undefined;
    const select = (required = false): ProjectSelection => {
      if (positional.length > 1 || Number(Boolean(positional[0])) + Number(Boolean(get('--critic'))) + Number(Boolean(get('--critics'))) + Number(Boolean(get('--artifacts'))) + Number(Boolean(options['--all'])) + Number(Boolean(fileCritics)) + Number(Boolean(fileArtifacts)) > 1) throw new Error('Choose one Artifact, --critic, --critics, --artifacts, --critics-file, --artifacts-file, or --all.');
      if (fileCritics) return { kind: 'critics', criticIds: fileCritics };
      if (fileArtifacts) return { kind: 'artifacts', artifactIds: fileArtifacts };
      if (positional[0]) return { kind: 'artifact', artifactId: positional[0] };
      if (get('--critics')) return { kind: 'critics', criticIds: get('--critics')!.split(',') };
      if (get('--artifacts')) return { kind: 'artifacts', artifactIds: get('--artifacts')!.split(',') };
      if (get('--critic')) return { kind: 'critic', criticId: get('--critic')! };
      if (required && !options['--all']) throw new Error('An Artifact, --critic ID, or --all is required.');
      return { kind: 'all' };
    };
    const stream = async (id: string) => withCliCancellation('Result subscription cancelled; execution continues.', async signal => {
      const after = Number(get('--after') ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) throw new Error('--after must be a non-negative integer cursor.');
      for await (const result of streamProjectResults(context.stateDir,id,{after,timeoutMs,signal})) {
        if (stdout.write(JSON.stringify(result)+'\n') === false && 'once' in stdout) await once(stdout as unknown as NodeJS.EventEmitter,'drain',{signal});
      }
      const run = projectRun(context.stateDir,id)!;
      stdout.write(JSON.stringify({type:'run',runId:id,status:run.status,...(run.publication ? {publication:run.publication} : {})})+'\n');
      return exitFor(run);
    });
    const verifySelection = command === 'verify' ? select(true) : undefined;
    const runOutput = (run: ProjectRunView) => full ? { ...run, workspaceIntegrity: run.workspace?.integrity ?? 'content' } : requesterRun(run, context.stateDir);
    const printRun = (run: ProjectRunView) => print(runOutput(run), full ? undefined : `Run: ${run.id}\nExecution: ${run.status}${run.publication ? `\nPublication: ${run.publication.state}${run.publication.code ? ` (${run.publication.code})` : ''}` : ''}\nIntegrity: ${run.workspace?.integrity ?? 'content'}${run.validation ? `\n${planText(requesterPlan(run.validation, context.stateDir))}` : ''}`);
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
        const graph = createGraphDefinition(config, false);
        if (selection.kind !== 'all') {
          const artifacts = new Set(requiredArtifacts({ config }, selection));
          graph.critics = graph.critics.filter(c => artifacts.has(c.target));
          graph.artifacts = Object.fromEntries(Object.entries(graph.artifacts).filter(([id]) => artifacts.has(id)));
          graph.relations = graph.relations.filter(edge => artifacts.has(edge.source) && artifacts.has(edge.target));
        }
        print(options['--compact'] ? compactGraphDefinition(graph) : graph, graph.critics.map(c => `${c.id}: ${c.deps.join(', ') || '(no deps)'} -> ${c.target}`).join('\n') || Object.keys(graph.artifacts).join('\n')); return 0;
      } finally { await workspace.close(); }
    }
    if (command === 'status' || command === 'plan') {
      const selection = select(command === 'plan');
      const { plan } = await withCliCancellation('Project validation cancelled.', signal => inspectProject({ profile: get('--profile'), detail: 'full', ...context, selection, recursive: Boolean(options['--recursive']), force: Boolean(options['--force']), ignoreGates: options['--ignore-gates'] ? true : undefined, workspaceIntegrity, identityConcurrency, signal }));
      const output = full ? plan : requesterPlan(plan, context.stateDir);
      print(output, full ? undefined : planText(requesterPlan(plan, context.stateDir))); return command === 'plan' || plan.satisfied ? 0 : 1;
    }
    if (command === 'history') {
      const selection = select();
      const history = projectHistory(context.stateDir, { detail: 'full' }), names = selection.kind === 'artifact' ? [selection.artifactId] : selection.kind === 'artifacts' ? selection.artifactIds : [];
      // A name that is no reviewed target may be an Artifact family. Members come from each request's recorded
      // definition and, for evidence recorded before a migration into the family, from the current static declarations.
      const familyNames = names.some(name => !history.some(e => e.input.target.id === name));
      const families = familyNames ? evidenceFamilies(context.stateDir, history) : new Map<string, string>();
      const current = familyNames ? await readWorkspaceConfig(context.repoPath).then(({ config }) => new Map(Object.entries(config.artifacts).flatMap(([id, artifact]) => artifact.family ? [[id, artifact.family.name] as const] : [])), () => new Map<string, string>()) : new Map<string, string>();
      const entries = history.filter(e => selection.kind === 'all' || selection.kind === 'critic' && e.criticId === selection.criticId || selection.kind === 'critics' && selection.criticIds.includes(e.criticId)
        || names.includes(e.input.target.id) || [families.get(e.requestId), current.get(e.input.target.id)].some(family => family !== undefined && names.includes(family)));
      print(full ? entries : entries.map(e => requesterEvidence(e, context.stateDir)), full ? undefined : entries.map(e => `${e.completedAt} ${e.criticId} ${e.verdict} · ${e.requestId}${e.publication ? ` · publication: ${e.publication.state}${e.publication.code ? ` (${e.publication.code})` : ''}` : ''}\n  ${JSON.stringify(e.result)}`).join('\n') || 'No recorded validation evidence.'); return 0;
    }
    if (command === 'run' || command === 'request') {
      const [action, id] = positional;
      const actions = command === 'run' ? ['list', 'show', 'resume', 'cancel', 'stream', 'summary', 'diff'] : ['list', 'show', 'claim', 'tool', 'submit', 'summary'];
      if (!actions.includes(action) || positional.length !== (action === 'list' ? 1 : action === 'diff' ? 3 : 2)) throw new Error(`Use ${command} ${actions.join('|')} with the appropriate ID.`);
      if (command === 'run' && options['--wait'] && !['show', 'resume'].includes(action)) throw new Error('--wait requires run show or run resume.');
      if (action === 'stream') return await stream(id);
      if (action === 'summary') { const summary = command === 'run' ? projectRunSummary(context.stateDir,id) : projectRequestSummary(context.stateDir,id); if (!summary) throw new Error('Review handle not found.'); print(summary); return 0; }
      if (action === 'diff') { print(compareProjectRuns({stateDir:context.stateDir,runId:id},{stateDir:context.stateDir,runId:positional[2]})); return 0; }
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
    broker = createBroker({ detail: 'full', ...context, executors, workspaceIntegrity, maxConcurrentExecutors, identityConcurrency });
    if (command === 'verify') {
      const run = await withCliCancellation('Project validation cancelled.', signal => broker!.submitProject({ profile: get('--profile'), maxExecutions, selection: verifySelection!, recursive: Boolean(options['--recursive']), force: Boolean(options['--force']), ignoreGates: options['--ignore-gates'] ? true : undefined, requesterId: get('--requester') ?? 'cli', signal }));
      if (!terminal.has(run.status)) await ensureRunWorker({ broker, context, run, initialConfig: { piOptions, humanInbox, maxConcurrentExecutors } });
      if (options['--stream']) return await stream(run.id);
      if (options['--wait']) return await wait(run.id);
      const view = projectRun(context.stateDir, run.id)!; printRun(view);
      return view.status === 'INCOMPLETE' ? 4 : view.status === 'ERROR' ? 2 : 0;
    }
    const [action, id] = positional;
    if (command === 'run') {
      let run = broker.getRun(id); if (!run) throw new Error('Review handle not found.');
      if (action === 'resume' && run.project?.version !== 3) throw new Error('Invalid stored Run format; submit a new validation request.');
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
