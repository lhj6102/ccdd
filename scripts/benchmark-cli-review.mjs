import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const [baselineRoot, candidateRoot] = process.argv.slice(2).map(value => resolve(value));
if (!baselineRoot || !candidateRoot) throw new Error('Usage: node scripts/benchmark-cli-review.mjs BASELINE_ROOT CANDIDATE_ROOT');
const files = Number(process.env.BENCH_FILES ?? 4000), rounds = Number(process.env.BENCH_ROUNDS ?? 3);
const mode = process.env.BENCH_MODE ?? 'lock';
const integrity = process.env.BENCH_INTEGRITY ?? 'content';
const baselineIntegrity = process.env.BENCH_BASELINE_INTEGRITY ?? 'content';
assert.ok(Number.isSafeInteger(files) && files > 0 && Number.isSafeInteger(rounds) && rounds > 0);
assert.ok(['copy', 'lock'].includes(mode) && [integrity, baselineIntegrity].every(value => ['content', 'metadata'].includes(value)));
const defaultTimeoutMs = Number(process.env.BENCH_TIMEOUT_MS ?? 600000);
assert.ok(Number.isSafeInteger(defaultTimeoutMs) && defaultTimeoutMs > 0 && defaultTimeoutMs <= 3600000);
const timeouts = Object.fromEntries(['admission', 'ready', 'claim', 'tool', 'result', 'settlement', 'cleanup'].map(stage => {
  const milliseconds = Number(process.env[`BENCH_${stage.toUpperCase()}_TIMEOUT_MS`] ?? (['settlement', 'cleanup'].includes(stage) ? 60000 : defaultTimeoutMs));
  assert.ok(Number.isSafeInteger(milliseconds) && milliseconds > 0 && milliseconds <= 3600000);
  return [stage, milliseconds];
}));
const sqliteTimeoutMs = Number(process.env.BENCH_SQLITE_TIMEOUT_MS ?? 5000);
assert.ok(Number.isSafeInteger(sqliteTimeoutMs) && sqliteTimeoutMs > 0 && sqliteTimeoutMs <= 60000);
const runFile = promisify(execFile);
const implementations = Object.fromEntries(await Promise.all([['baseline', baselineRoot], ['candidate', candidateRoot]].map(async ([label, cwd]) => {
  const commit = (await runFile('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  const changed = (await runFile('git', ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'], { cwd })).stdout.trim();
  return [label, { commit, trackedChanges: Boolean(changed) }];
})));
const { removeOwnedWorkspaceTree } = await import(pathToFileURL(join(candidateRoot, 'dist/src/workspaces/index.js')).href);
const root = await mkdtemp(join(tmpdir(), 'ccdd-cli-benchmark-')), repoPath = join(root, 'input');
const samples = [], attempts = [], cleanupIssues = [];
let canonicalRepoPath, report, primaryError;
const terminal = new Set(['GREEN', 'RED', 'ERROR', 'INCOMPLETE']);
const samePath = (left, right) => process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);

function rememberWorker(attempt, runId, pid, identity) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647 && pid !== process.pid, 'Invalid fixture worker PID.');
  const key = `${runId}:${pid}`, previous = attempt.workers.get(key);
  if (previous) {
    if (identity && previous.identity && identity !== previous.identity) throw new Error('Fixture worker identity changed; cleanup cannot be proven.');
    previous.identity ??= identity;
  } else attempt.workers.set(key, { runId, pid, identity: identity ?? null, exited: false });
}

// Read only the unique, caller-owned per-attempt store. Recovering all its runs
// also covers verify failures after persistence but before stdout reaches us.
function inspect(attempt) {
  const filename = join(attempt.stateDir, 'broker.sqlite');
  if (!existsSync(filename)) return { runs: [], requests: [], owners: [] };
  const db = new DatabaseSync(filename, { readOnly: true, timeout: sqliteTimeoutMs });
  try {
    db.exec('BEGIN');
    const runs = db.prepare('SELECT data FROM runs').all().map(row => JSON.parse(row.data));
    const identityRow = db.prepare("SELECT value FROM metadata WHERE key = 'registered-repo'").get();
    if (identityRow) assert.ok(samePath(JSON.parse(identityRow.value).repoPath, canonicalRepoPath), 'Store belongs to another input.');
    else assert.equal(runs.length, 0, 'Fixture store has runs but no repository identity.');
    const ids = new Set(runs.map(run => {
      assert.ok(typeof run.id === 'string' && /^[A-Za-z0-9_-]+$/.test(run.id));
      assert.ok(samePath(run.workspace.sourcePath, canonicalRepoPath) && samePath(run.workspace.stateDir, attempt.stateDir), 'Run belongs to another fixture.');
      return run.id;
    }));
    const owners = db.prepare('SELECT run_id,pid,process_identity FROM run_owners').all();
    for (const owner of owners) {
      assert.ok(ids.has(owner.run_id), 'Unknown fixture owner.');
      rememberWorker(attempt, owner.run_id, Number(owner.pid), owner.process_identity);
    }
    for (const event of db.prepare("SELECT run_id,data FROM events WHERE type = 'worker.started'").all()) {
      assert.ok(ids.has(event.run_id), 'Unknown fixture worker event.');
      rememberWorker(attempt, event.run_id, JSON.parse(event.data).pid, null);
    }
    const requests = db.prepare('SELECT data FROM requests ORDER BY ordinal').all().map(row => JSON.parse(row.data));
    db.exec('COMMIT');
    return { runs, requests, owners };
  } finally { db.close(); }
}

async function workersExited(attempt) {
  for (const worker of attempt.workers.values()) {
    if (worker.exited) continue;
    try { process.kill(worker.pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') { worker.exited = true; continue; }
      throw new Error(`Cannot establish exit of fixture worker ${worker.pid}: ${error.code ?? 'unknown error'}.`);
    }
    if (process.platform === 'linux') {
      try {
        const stat = await readFile(`/proc/${worker.pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const identity = `linux:${fields[19]}`;
        if (fields[0] === 'Z') { worker.exited = true; continue; }
        // A recycled PID is not the original worker. Never signal either process.
        if (worker.identity?.startsWith('linux:') && worker.identity !== identity) worker.exited = true;
        else worker.identity ??= identity;
      } catch (error) {
        if (error.code === 'ENOENT') worker.exited = true;
        else throw error;
      }
    }
  }
  return [...attempt.workers.values()].every(worker => worker.exited);
}

async function awaitSettlement(attempt, deadline) {
  let ownershipReleasedAt;
  for (;;) {
    const state = inspect(attempt);
    if (!state.owners.length) ownershipReleasedAt ??= performance.now();
    const exited = await workersExited(attempt);
    if (!state.owners.length && exited) return { ownershipReleasedAt, stoppedAt: performance.now() };
    assert.ok(Date.now() < deadline, 'Fixture worker settlement timed out; input must be retained.');
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}

async function cleanup(attempt) {
  if (attempt.settled || attempt.cleanupAttempted) return;
  attempt.cleanupAttempted = true;
  const deadline = Date.now() + timeouts.cleanup;
  try {
    const state = inspect(attempt);
    for (const run of state.runs) {
      if (terminal.has(run.status) && !state.owners.some(owner => owner.run_id === run.id)) continue;
      assert.ok(Date.now() < deadline, 'Fixture cancellation timed out.');
      try { await attempt.invoke(['run', 'cancel', run.id], 'cleanup', Math.max(1, deadline - Date.now())); }
      catch (error) { process.stderr.write(`Fixture cancellation failed for ${run.id}: ${String(error)}\n`); }
    }
    await awaitSettlement(attempt, deadline);
    // A timed-out admission could have forked a worker that has not reached its
    // ownership record yet. Cancellation stops its Run, but no observed PID means
    // we cannot prove that detached process has exited. Preserve its input.
    if (!attempt.admissionReturned && state.runs.length && !attempt.workers.size) {
      throw new Error('Admission failed before a worker identity was recorded; detached process absence cannot be proven.');
    }
    attempt.settled = true;
  } catch (error) {
    cleanupIssues.push({ stateDirectory: basename(attempt.stateDir), message: String(error), workers: [...attempt.workers.values()] });
  }
}

function assertPolicy(workspace, expected) {
  assert.ok(workspace && workspace.mode === mode && /^[a-f0-9]{64}$/.test(workspace.hash) && /^[a-f0-9]{64}$/.test(workspace.baselineMetadataHash));
  assert.equal(workspace.integrity ?? 'content', expected, 'Persisted integrity policy differs from requested policy.');
  if (expected === 'metadata') assert.match(workspace.structureHash, /^[a-f0-9]{64}$/);
}
try {
  await mkdir(repoPath);
  canonicalRepoPath = await realpath(repoPath);
  for (let d = 0; d < Math.ceil(files / 100); d++) await mkdir(join(repoPath, `dependency-${d}`));
  for (let i = 0; i < files; i++) await writeFile(join(repoPath, `dependency-${Math.floor(i / 100)}`, `${i}.js`), Buffer.alloc(1024, i % 251));
  await writeFile(join(repoPath, 'runtime.bin'), Buffer.alloc(64 * 1024 * 1024, 51));
  await writeFile(join(repoPath, 'artifact.txt'), 'Synthetic CLI benchmark Artifact.\n');
  await writeFile(join(repoPath, 'ccdd.config.ts'), `
    import { readFile } from 'node:fs/promises';
    export default {
      artifacts: { sample: { type: 'custom', path: 'artifact.txt' } },
      artifactTypes: { custom: { humanTools: { inspect: {
        metadata: { description: 'Read the synthetic {artifactName}.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, resultKinds: ['json'], observation: 'content', artifactKind: 'file' },
        async execute(context) {
          const started = performance.now();
          const text = await readFile(context.artifactPath, 'utf8');
          const executionMs = performance.now() - started;
          return { content: [{ type: 'json', data: { text, executionMs } }], observation: { kind: 'content' } };
        }
      } } } },
      critics: [{ id: 'inspect-sample', title: 'Synthetic CLI benchmark request', target: 'sample', deps: [], profile: { kind: 'human' }, payload: { instruction: 'Inspect the controlled benchmark fixture.' } }]
    };
  `);
  const verdictPath = join(root, 'fixture-verdict.json');
  await writeFile(verdictPath, JSON.stringify({ verdict: 'GREEN', summary: 'Controlled synthetic benchmark only; not an actual Human review.', evidence: ['A test caller returned this fixture verdict.'] }));
  for (let round = -1; round < rounds; round++) {
    for (const index of round % 2 === 0 ? [0, 1] : [1, 0]) {
      const label = index ? 'candidate' : 'baseline', moduleRoot = index ? candidateRoot : baselineRoot;
      const stateDir = join(root, `${round}-${label}`), cli = join(moduleRoot, 'dist/src/project/cli.js');
      const invoke = async (args, stage, timeoutMs = timeouts[stage]) => {
        assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'A bounded CLI stage timeout is required.');
        const result = await runFile(process.execPath, [cli, ...args, '--repo', repoPath, '--state-dir', stateDir, '--json'], {
          cwd: moduleRoot, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
          env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')),
        });
        return JSON.parse(result.stdout);
      };
      const attempt = { stateDir, invoke, workers: new Map(), admissionReturned: false, settled: false, cleanupAttempted: false };
      attempts.push(attempt);
      try {
        const started = performance.now();
        const expectedIntegrity = index ? integrity : baselineIntegrity;
        const accepted = await invoke(['verify', 'sample', `--${mode}`, '--force', '--human-inbox', ...(expectedIntegrity === 'metadata' ? ['--integrity', 'metadata'] : [])], 'admission');
        attempt.admissionReturned = true;
        const runId = accepted.id;
        assert.ok(runId);
        const submitted = performance.now(), deadline = Date.now() + timeouts.ready;
        assertPolicy(accepted.workspace, expectedIntegrity);
        let request;
        do {
          const state = inspect(attempt);
          assert.equal(state.runs.length, 1, 'Expected exactly one controlled fixture Run.');
          request = state.requests.find(value => value.runId === runId);
          assert.ok(!request || !['ERROR', 'RED'].includes(request.status), JSON.stringify(request));
          if (request) assertPolicy(request.workspace, expectedIntegrity);
          if (request?.notifiedAt) break;
          assert.ok(Date.now() < deadline, 'Human notification timed out.');
          await delay(25);
        } while (true);
        assert.ok(attempt.workers.size > 0, 'No persisted worker identity was observed for this fixture.');
        const ready = performance.now(), id = request.id;
        await invoke(['request', 'claim', id, '--reviewer', 'benchmark-reviewer'], 'claim');
        const claimed = performance.now();
        const output = await invoke(['request', 'tool', id, '--reviewer', 'benchmark-reviewer', '--tool', 'inspect_sample', '--args', '{}'], 'tool');
        const toolReturned = performance.now();
        const payload = output.content.find(item => item.type === 'json')?.data;
        assert.equal(payload?.text, 'Synthetic CLI benchmark Artifact.\n');
        assert.ok(Number.isFinite(payload.executionMs) && payload.executionMs >= 0 && payload.executionMs <= toolReturned - claimed);
        const result = await invoke(['request', 'submit', id, '--reviewer', 'benchmark-reviewer', '--result-file', verdictPath], 'result');
        assert.equal(result.status, 'GREEN');
        const returned = performance.now();
        const settlement = await awaitSettlement(attempt, Date.now() + timeouts.settlement);
        const stopped = settlement.stoppedAt;
        attempt.settled = true;
        const row = { label, round, mode, integrity: expectedIntegrity, admissionMs: submitted - started,
          readyMs: ready - submitted, claimMs: claimed - ready, toolOverheadMs: toolReturned - claimed - payload.executionMs,
          resultReturnMs: returned - toolReturned, ownershipReleaseMs: Math.max(0, settlement.ownershipReleasedAt - returned),
          workerStopMs: stopped - returned, customReadMs: payload.executionMs,
          frameworkMs: stopped - started - payload.executionMs };
        if (round >= 0) samples.push(row);
        process.stderr.write(JSON.stringify(row) + '\n');
      } finally {
        await cleanup(attempt);
      }
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const metrics = ['admissionMs', 'readyMs', 'claimMs', 'toolOverheadMs', 'resultReturnMs', 'ownershipReleaseMs', 'workerStopMs', 'frameworkMs'];
  const summary = Object.fromEntries(['baseline', 'candidate'].map(label => [label, Object.fromEntries(metrics.map(metric => [metric, median(samples.filter(row => row.label === label).map(row => row[metric]))]))]));
  const pairedRatios = Array.from({ length: rounds }, (_, round) => samples.find(row => row.round === round && row.label === 'candidate').frameworkMs / samples.find(row => row.round === round && row.label === 'baseline').frameworkMs);
  report = { node: process.version, platform: process.platform, implementations, files, binaryBytes: 64 * 1024 * 1024, rounds, mode, baselineIntegrity, candidateIntegrity: integrity, timeouts, sqliteTimeoutMs,
    policyComparison: { baseline: baselineIntegrity, candidate: integrity, identicalGuarantees: integrity === baselineIntegrity,
      description: integrity === baselineIntegrity ? integrity === 'content' ? 'Both implementations rehash content at integrity boundaries.' : 'Both implementations use metadata integrity after full initial content capture.' : `Baseline uses ${baselineIntegrity} integrity; candidate uses ${integrity} integrity. This compares different integrity guarantees.` },
    scope: 'Actual project CLI invocations, separate Node processes, detached worker startup, acquisition, claim, tool response, result return and worker settlement. Only the instrumented custom read body is subtracted; trivial custom result construction remains. Fixture setup, npm install and Human think time excluded. No HTTP/UI-rendering claim. Synthetic fixtures only.',
    summary, pairedRatios, remainingRatio: summary.candidate.frameworkMs / summary.baseline.frameworkMs,
    meetsTarget: summary.candidate.frameworkMs / summary.baseline.frameworkMs < 0.1, samples };
} catch (error) {
  primaryError = error;
} finally {
  for (const attempt of attempts) await cleanup(attempt);
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(basename(root).startsWith('ccdd-cli-benchmark-'));
  if (cleanupIssues.length) {
    await writeFile(join(root, 'cleanup-report.json'), JSON.stringify({ issues: cleanupIssues }, null, 2)).catch(() => {});
    process.stderr.write(`Cleanup could not establish worker settlement. Temporary input and state retained at ${root}\n`);
  } else {
    try { await removeOwnedWorkspaceTree(root); }
    catch (error) {
      cleanupIssues.push({ message: String(error) });
      process.stderr.write(`Temporary fixture cleanup failed; retained remnants at ${root}\n`);
    }
  }
}
if (primaryError || cleanupIssues.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...cleanupIssues.map(issue => new Error(issue.message))], 'CLI benchmark did not complete cleanly.');
const reportText = JSON.stringify(report, null, 2);
if (process.env.BENCH_REPORT_FILE) await writeFile(resolve(process.env.BENCH_REPORT_FILE), reportText + '\n');
console.log(reportText);
