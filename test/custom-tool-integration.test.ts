import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from '@earendil-works/pi-ai';
import { createExecutorRegistry } from '../src/executors/index.js';
import { createBroker } from '../src/broker/index.js';
import type { StreamFn } from '../src/executors/pi.js';
import { diagnoseProject } from '../src/doctor/index.js';
import { diagnoseArtifactTools } from '../src/artifacts/tool-check.js';
import { serveArtifactMcp } from '../src/artifacts/mcp-server.js';
import { prepareReviewRequests } from '../src/requester/index.js';
import { artifactStream } from './pi-fixture.js';
import { removeOwnedWorkspaceTree } from '../src/workspaces/index.js';
import type { AgentProfile } from '../src/contracts.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
const agentProfile: AgentProfile = { kind: 'agent', provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'medium', timeoutMs: 10_000 };
const verdict = { verdict: 'GREEN', summary: 'Frame checked', evidence: ['Observed the specified frame.'] };

async function fixture(t: TestContext, { observation = true, preflight = true, hang = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ccdd-custom-adapters-'));
  t.after(() => removeOwnedWorkspaceTree(dir));
  const repoPath = join(dir, 'repo');
  await mkdir(repoPath);
  await writeFile(join(repoPath, 'clip.bin'), Buffer.from([0, 255, 12, 8]));
  const launched = join(dir, 'launched');
  const hostPid = join(dir, 'host-pid');
  await writeFile(join(repoPath, 'ccdd.config.ts'), `
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const schema = { type: 'object', additionalProperties: false, properties: { frame: { type: 'integer', minimum: 0, maximum: 4 }, channels: { type: 'array', items: { type: 'string', enum: ['color', 'depth'] } }, transparent: { type: 'boolean' } }, required: ['frame', 'transparent'] };
export default () => ({
  artifacts: { clip: { type: 'animation', path: 'clip.bin' } },
  artifactTypes: { animation: {
    agentTools: { frame: {
      metadata: { description: 'Observe the specified frame in {artifactName}.', inputSchema: schema, resultKinds: ['image'], observation: ${JSON.stringify(observation ? 'content' : 'none')}, artifactKind: 'file' },
      ${preflight ? "preflight: async () => ({ ok: true, message: 'Renderer registration checked without rendering.' })," : ''}
      async execute(context, args) {
        ${hang ? `await writeFile(${JSON.stringify(hostPid)}, String(process.pid)); await new Promise(() => {});` : ''}
        const image = join(context.outputDir, 'frame.png');
        await writeFile(image, Buffer.from('${png}', 'base64'));
        return { content: [{ type: 'image', path: image, mimeType: 'image/png' }]${observation ? ", observation: { kind: 'content', detail: 'frame ' + args.frame }" : ''} };
      }
    } },
    humanTools: { open: {
      metadata: { description: 'Open {artifactName} on the desktop.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, resultKinds: ['launch'], observation: 'none', artifactKind: 'file' },
      preflight: async () => ({ ok: true, message: 'Desktop registration checked without launching.' }),
      async execute(context) { await writeFile(${JSON.stringify(launched)}, context.artifactPath); return { content: [{ type: 'launch', launched: true }] }; }
    } }
  } },
  critics: [
    { id: 'frame-review', title: 'Frame review', target: 'clip', deps: [], profile: ${JSON.stringify(agentProfile)}, payload: { instruction: 'Inspect the frame.' } },
    { id: 'human-review', title: 'Human review', target: 'clip', deps: [], profile: { kind: 'human' }, payload: { instruction: 'Inspect in the application.' } }
  ]
});
`);
  const [request] = await prepareReviewRequests({ repoPath, repoId: 'custom-test', snapshotHash: 'a'.repeat(64), criticId: 'frame-review' });
  assert.ok(request.configManifest, 'The test must exercise snapshot TS registration, not a legacy built-in adapter.');
  return { dir, repoPath, worktreePath: repoPath, stateDir: join(dir, 'state'), runDir: join(dir, 'review'), launched, hostPid, request };
}

function frameStream({ args = { frame: 2, transparent: false, channels: ['color'] }, onResult }: { args?: Record<string, unknown>; onResult?: (result: ToolResultMessage) => void } = {}): StreamFn {
  let faux: ReturnType<typeof fauxProvider> | undefined;
  let started = false;
  return (model, context, options) => {
    faux ??= fauxProvider({ provider: model.provider, api: model.api });
    for (const message of context.messages) if (message.role === 'toolResult') onResult?.(message);
    if (!started) {
      const [tool] = context.tools ?? [];
      assert.equal(tool?.name, 'frame_clip');
      assert.match(tool.description, /Observe the specified frame in clip/);
      started = true;
      faux.appendResponses([fauxAssistantMessage([fauxToolCall('frame_clip', args)], { stopReason: 'toolUse' }), fauxAssistantMessage(JSON.stringify(verdict))]);
    }
    return faux.provider.streamSimple(model, context, options);
  };
}

test('custom frame tool reaches the real Pi Agent as image content and satisfies artifact observation without read/list', async t => {
  const data = await fixture(t);
  let observed = false;
  const result = await createExecutorRegistry({ streamFn: frameStream({ onResult(message) {
    assert.equal(message.isError, false);
    assert.deepEqual(message.content, [{ type: 'image', data: png, mimeType: 'image/png' }]);
    observed = true;
  } }) }).execute(data.request, data);
  assert.ok(observed);
  assert.equal(result.verdict, 'GREEN');
  assert.equal(result.toolCalls?.[0].name, 'frame_clip');
  assert.deepEqual(result.toolCalls?.[0].observation, { artifactId: 'clip', operation: 'frame', kind: 'content', detail: 'frame 2' });
  assert.doesNotMatch(JSON.stringify(result), /frame\.png|iVBOR/);
});

test('custom tool images explicitly fail for a text-only model instead of reaching transport as JSON', async t => {
  const data = await fixture(t);
  const request = { ...data.request, profile: { ...agentProfile, provider: 'openai', model: 'o3-mini' } };
  let sawImage = false;
  await assert.rejects(createExecutorRegistry({ streamFn: frameStream({ onResult(message) { sawImage ||= message.content.some(block => block.type === 'image'); } }) }).execute(request, data), error => {
    assert.equal((error as { code?: string }).code, 'ARTIFACT_IMAGE_UNSUPPORTED');
    return true;
  });
  assert.equal(sawImage, false);
});

test('custom schema errors and results without observations cannot pass a required Artifact', async t => {
  for (const args of [{ frame: '2', transparent: false }, { frame: 2, transparent: 'false' }, { frame: 2, transparent: false, channels: ['invalid'] }]) {
    const data = await fixture(t);
    await assert.rejects(createExecutorRegistry({ streamFn: frameStream({ args }) }).execute(data.request, data), /did not inspect required artifact: clip/);
  }
  const data = await fixture(t, { observation: false });
  await assert.rejects(createExecutorRegistry({ streamFn: frameStream() }).execute(data.request, data), /did not inspect required artifact: clip/);
});

test('MCP exposes arbitrary schemas and sends image content with the same audited observation', async t => {
  const data = await fixture(t);
  const manifestPath = join(data.dir, 'mcp-manifest.json'), auditPath = join(data.dir, 'audit.jsonl');
  await writeFile(manifestPath, JSON.stringify({ worktreePath: data.worktreePath, artifacts: data.request.artifacts, artifactTypes: data.request.artifactTypes, configManifest: data.request.configManifest, runDir: data.runDir, auditPath }));
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'frame_clip', arguments: { frame: 1, transparent: true } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'frame_clip', arguments: { frame: -1, transparent: true } } },
  ];
  let output = '';
  await serveArtifactMcp({ manifestPath, input: Readable.from(messages.map(message => `${JSON.stringify(message)}\n`)), output: new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } }) });
  const replies = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies[0].result.tools[0].name, 'frame_clip');
  assert.equal(replies[0].result.tools[0].inputSchema.properties.transparent.type, 'boolean');
  assert.deepEqual(replies[1].result.content, [{ type: 'image', data: png, mimeType: 'image/png' }]);
  assert.equal(replies[2].result.isError, true);
  const audit = (await readFile(auditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].observation.kind, 'content');
});

test('TS tools check preflights without rendering or launching and executes only an explicit tool selection', async t => {
  const data = await fixture(t);
  const report = await diagnoseArtifactTools(data);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.deepEqual(report.tools.map(tool => tool.name).sort(), ['frame_clip', 'open_clip']);
  await assert.rejects(readFile(data.launched), { code: 'ENOENT' });
  const run = await diagnoseArtifactTools({ ...data, artifactId: 'clip', audience: 'human', toolName: 'open', execute: true });
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.ok(run.result && 'content' in run.result && Array.isArray(run.result.content));
  assert.equal(await readFile(data.launched, 'utf8'), join(run.workspacePath!, 'clip.bin'));
});

test('doctor preflights TS tools without executing', async t => {
  const data = await fixture(t);
  let probes = 0;
  const report = await diagnoseProject({ ...data, criticId: 'human-review', executors: { async probe() { probes++; return { ok: true, message: 'Human registration checked.', details: { notificationsSent: false } }; } } });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(probes, 1);
  assert.equal(report.checks.find(check => check.id === 'artifacts:human-review')?.details?.programsLaunched, false);
  await assert.rejects(readFile(data.launched), { code: 'ENOENT' });
});


test('Provider readiness uses its private nonce even when the project has only custom image tools', async t => {
  const data = await fixture(t);
  const result = await createExecutorRegistry({ streamFn: artifactStream() }).probe(data.request, data);
  assert.equal(result.ok, true);
  assert.equal(result.details.operation, 'provider-artifact-roundtrip');
  const calls = result.details.toolCalls as Array<{ name: string }>;
  assert.equal(calls.length, 1);
  assert.match(calls[0].name, /^read_ccdd_probe_/);
  assert.equal(data.request.configManifest?.types.animation.agentTools.frame.resultKinds[0], 'image');
});


test('Pi timeout closes a running custom tool host before returning an execution error', async t => {
  const data = await fixture(t, { hang: true });
  const started = performance.now();
  await assert.rejects(createExecutorRegistry({ streamFn: frameStream() }).execute({ ...data.request, profile: { ...agentProfile, timeoutMs: 5_000 } }, data), /timed out/);
  assert.ok(performance.now() - started < 10_000);
  const pid = Number(await readFile(data.hostPid, 'utf8'));
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('failed custom observation persistence cannot satisfy the Agent required Artifact check', async t => {
  const data = await fixture(t);
  await assert.rejects(createExecutorRegistry({ streamFn: frameStream() }).execute(data.request, {
    ...data,
    onEvent(event) { if (event.type === 'artifact.tool.called') throw new Error('Audit persistence unavailable.'); },
  }), /did not inspect required artifact: clip/);
});

test('Broker persists custom operation and observation kind through completion and restart', async t => {
  const data = await fixture(t);
  const broker = createBroker({ repoPath: data.repoPath, stateDir: data.stateDir, executors: createExecutorRegistry({ streamFn: frameStream() }) });
  t.after(() => broker.close());
  const submitted = await broker.submit({ mode: 'copy', criticId: 'frame-review', requesterId: 'integration-test' });
  const completed = await broker.run(submitted.id);
  assert.ok(completed);
  assert.equal(completed.status, 'GREEN');
  const observation = { artifactId: 'clip', operation: 'frame', kind: 'content', detail: 'frame 2' };
  assert.deepEqual(completed.requests[0].result?.toolCalls?.[0].observation, observation);
  assert.deepEqual((broker.getRun(submitted.id)!.events.find(event => event.type === 'artifact.tool.called')?.data as { observation?: unknown }).observation, observation);
  await broker.close();
  const reopened = createBroker({ repoPath: data.repoPath, stateDir: data.stateDir });
  try { assert.deepEqual(reopened.getRun(submitted.id)!.requests[0].result?.toolCalls?.[0].observation, observation); }
  finally { await reopened.close(); }
});
