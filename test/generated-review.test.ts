import { runUntilSettled } from './helpers/run.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createBroker } from '../src/broker/index.js';
import { createExecutorRegistry } from '../src/executors/index.js';
import { serveArtifactMcp } from '../src/artifacts/mcp-server.js';
import { createMonitorStore } from '../src/monitor/store.js';
import { removeOwnedWorkspaceTree } from '../src/workspaces/index.js';
import type { CriticProfile } from '../src/contracts.js';
import type { StreamFn } from '../src/executors/pi.js';

const agent: CriticProfile = { kind: 'agent', provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'medium', timeoutMs: 15000 };
const verdict = { verdict: 'GREEN' as const, summary: 'Fixture reviewer inspected the scenario.', evidence: ['The actual scoped overview tool returned the captured scenario.'] };

async function fixture(t: TestContext, profile: CriticProfile, streamFn?: StreamFn) {
  const root = await mkdtemp(join(tmpdir(), 'ccdd-generated-review-'));
  const repoPath = join(root, 'repo'), stateDir = join(root, 'state');
  await mkdir(repoPath);
  const liveData = join(root, 'live.json'), calls = join(root, 'source-calls'), configCalls = join(root, 'config-calls');
  await writeFile(liveData, JSON.stringify({ summary: 'Captured overview', detail: 'DEFERRED_EVIDENCE_28' }));
  await writeFile(calls, ''); await writeFile(configCalls, '');
  await writeFile(join(repoPath, 'ccdd.config.ts'), `
import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(configCalls)}, 'loaded\\n');
const overview = {
  metadata: { description: 'Read the overview of {artifactName}.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, resultKinds: ['text'], observation: 'content', artifactKind: 'data' },
  execute(context) { return { content: [{ type: 'text', text: context.readData().summary }], observation: { kind: 'content' } }; }
};
export default {
  artifacts: { scenario: { kind: 'generated', type: 'scenario', source: 'simulation' } },
  artifactSources: { simulation: {
    metadata: { identity: { kind: 'canonical-data', namespace: 'test/scenario', version: '1' }, preparation: 'read-only' },
    prepare() { appendFileSync(${JSON.stringify(calls)}, 'prepared\\n'); return { data: JSON.parse(readFileSync(${JSON.stringify(liveData)}, 'utf8')) }; }
  } },
  artifactTypes: { scenario: { agentTools: { overview }, humanTools: { overview } } },
  critics: [{ id: 'review', title: 'Inspect scenario', target: 'scenario', deps: [], profile: ${JSON.stringify(profile)}, payload: { instruction: 'Inspect {scenario} through its scoped tool.' } }]
};`);
  const broker = createBroker({ repoPath, stateDir, executors: createExecutorRegistry({ streamFn, alarmMethods: [async () => {}] }) });
  t.after(async () => { await broker.close(); await removeOwnedWorkspaceTree(root); });
  const run = await broker.submitProject({ selection: { kind: 'all' } });
  return { root, repoPath, stateDir, liveData, calls, configCalls, broker, run };
}

test('generated data reaches the actual Agent loop only through scoped tools and equivalent evidence avoids another model call', async t => {
  let transport: ReturnType<typeof fauxProvider> | undefined;
  let modelCalls = 0;
  const streamFn: StreamFn = (model, context, options) => {
    modelCalls++;
    assert.doesNotMatch(JSON.stringify(context.messages), /DEFERRED_EVIDENCE_28/);
    assert.deepEqual(context.tools?.map(tool => tool.name), ['overview_scenario']);
    transport ??= fauxProvider({ provider: model.provider, api: model.api });
    const observed = context.messages.some(message => message.role === 'toolResult');
    transport.appendResponses([async () => observed ? fauxAssistantMessage(JSON.stringify(verdict)) : fauxAssistantMessage([fauxToolCall('overview_scenario', {})], { stopReason: 'toolUse' })]);
    return transport.provider.streamSimple(model, context, options);
  };
  const f = await fixture(t, agent, streamFn);
  await runUntilSettled(f.broker, f.run.id);
  const completed = f.broker.getRun(f.run.id)!;
  assert.equal(completed.status, 'GREEN', JSON.stringify(completed.requests.map(request => request.error)));
  assert.equal(completed.requests[0].result?.toolCalls?.[0].observation?.artifactId, 'scenario');
  assert.equal(modelCalls, 2);
  const reused = await f.broker.submitProject({ selection: { kind: 'all' } });
  assert.equal(reused.status, 'GREEN');
  assert.equal(reused.requests.length, 0);
  assert.equal(modelCalls, 2);
  await writeFile(f.liveData, JSON.stringify({ summary: 'Captured overview', detail: 'CHANGED_UNREAD_EVIDENCE' }));
  const changed = await f.broker.submitProject({ selection: { kind: 'all' } });
  assert.equal(changed.requests.length, 1);
  assert.notEqual(changed.requests[0].validationInput?.key, completed.requests[0].validationInput?.key);
});

test('local Human review reopens captured generated data while metadata GETs remain observational', async t => {
  const f = await fixture(t, { kind: 'human' });
  await runUntilSettled(f.broker, f.run.id);
  const request = f.broker.getRun(f.run.id)!.requests[0];
  const monitor = createMonitorStore({ stateDirs: [f.stateDir] });
  const sourceCalls = await readFile(f.calls, 'utf8'), configCalls = await readFile(f.configCalls, 'utf8');
  const database = await readFile(join(f.stateDir, 'broker.sqlite'));
  const overview = await monitor.overview();
  const detail = await monitor.detail(overview.projects[0].id, request.id);
  assert.ok(detail);
  assert.deepEqual(detail.artifacts, [{ id: 'scenario', type: 'scenario', kind: 'generated', source: 'simulation' }]);
  assert.equal(await readFile(f.configCalls, 'utf8'), configCalls);
  assert.deepEqual(await readFile(join(f.stateDir, 'broker.sqlite')), database);
  await writeFile(f.liveData, JSON.stringify({ summary: 'New live revision', detail: 'Changed source' }));
  await f.broker.claimHuman(request.id, 'reviewer');
  const result = await f.broker.executeHumanTool(request.id, { reviewerId: 'reviewer', toolName: 'overview_scenario' });
  assert.deepEqual(result, { content: [{ type: 'text', text: 'Captured overview' }], observation: { kind: 'content' } });
  assert.equal(await readFile(f.calls, 'utf8'), sourceCalls, 'Reopening must never rerun source preparation.');
  await f.broker.completeHuman(request.id, { reviewerId: 'reviewer', result: verdict });
  assert.equal(f.broker.getRequest(request.id)?.status, 'GREEN');
});

test('MCP data tools use recorded input and reject a missing generated snapshot', async t => {
  const f = await fixture(t, agent);
  const request = f.run.requests[0];
  const manifest = { worktreePath: request.worktreePath, artifacts: request.artifacts, artifactTypes: request.artifactTypes, configManifest: request.configManifest, criticId: request.criticId, runDir: join(f.root, 'mcp-output') };
  const manifestPath = join(f.root, 'mcp.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  let output = '';
  await serveArtifactMcp({ manifestPath, input: Readable.from([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'overview_scenario', arguments: {} } }) + '\n']), output: new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } }) });
  assert.match(output, /Captured overview/);
  assert.doesNotMatch(output, /DEFERRED_EVIDENCE_28/);
  const artifact = manifest.artifacts[0];
  assert.equal(artifact.kind, 'generated');
  if (artifact.kind === 'generated') delete artifact.input;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(serveArtifactMcp({ manifestPath, input: Readable.from([]), output: new Writable({ write(_chunk, _encoding, callback) { callback(); } }) }), /manifest|snapshot/i);
});
