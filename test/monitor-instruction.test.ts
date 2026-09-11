import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { compileScript, parse } from 'vue/compiler-sfc';
import { createRenderer, h, nextTick, reactive, ref } from 'vue';
import type { Component } from 'vue';
import type { MonitorDetail, MonitorHumanTool, MonitorRequest } from '../src/monitor/types.js';
import type { GraphCriticState } from '../src/broker/graph.js';
// Include the SFC's runtime helpers in the normal test compilation.
import '../src/monitor/ui/api.js';
import '../src/monitor/ui/tool-input.js';
import '../src/monitor/ui/tool-content.js';
import '../src/monitor/ui/critic-presentation.js';
import '../src/monitor/ui/format.js';

type Node = {
  type: string; text: string; props: Record<string, any>; children: Node[]; parent: Node | null;
  value: unknown; checked: boolean; tagName: string; readonly options: Node[];
  focus(): void; scrollIntoView(): void; addEventListener(): void; removeEventListener(): void;
  querySelector(): null; getRootNode(): typeof documentState;
};
const documentState = { activeElement: null as Node | null };
function browserGlobals(t: TestContext): void {
  for (const [key, value] of Object.entries({ document: documentState, Document: class {}, ShadowRoot: class {}, HTMLInputElement: class {},
    window: { addEventListener() {}, removeEventListener() {} } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
}
function node(type: string, text = ''): Node {
  return { type, text, props: {}, children: [], parent: null, value: '', checked: false, tagName: type.toUpperCase(),
    get options() { return this.children; },
    focus() { documentState.activeElement = this; }, scrollIntoView() {}, addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, getRootNode() { return documentState; } };
}
const renderer = createRenderer<Node, Node>({
  querySelector: () => node('body'),
  createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text),
  insert(child, parent, anchor = null) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
  },
  remove(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; },
  setText(child, text) { child.text = text; },
  setElementText(child, text) { child.text = text; child.children = []; },
  parentNode: child => child.parent, nextSibling: child => child.parent?.children[child.parent.children.indexOf(child) + 1] ?? null,
  patchProp(child, key, _previous, value) { child.props[key] = value; },
});
function all(root: Node): Node[] { return [root, ...root.children.flatMap(all)]; }
function text(root: Node): string { return root.type === '#comment' ? '' : root.text + root.children.map(text).join(''); }
function matching(root: Node, type: string, label: string): Node {
  const found = all(root).find(child => child.type === type && text(child).includes(label));
  assert.ok(found, `Missing ${type}: ${label}`); return found;
}
function mount(component: Component, props: Record<string, unknown>, host: Node) {
  const view = ref();
  const app = renderer.createApp({ setup: () => () => h(component, { ...props, ref: view }) });
  app.mount(host); return { app, view: view.value as { showArtifactTools(artifactId: string): void } };
}
async function component(name: string): Promise<Component> {
  const source = await readFile(new URL(`../../src/monitor/ui/${name}.vue`, import.meta.url), 'utf8');
  const script = compileScript(parse(source, { filename: `${name}.vue` }).descriptor, { id: name, inlineTemplate: true });
  let code = stripTypeScriptTypes(script.content, { mode: 'transform' });
  code = code.replace(/from (['"])vue\1/g, `from ${JSON.stringify(import.meta.resolve('vue'))}`);
  code = code.replace(/from (['"])@lucide\/vue\1/g, `from ${JSON.stringify(import.meta.resolve('@lucide/vue'))}`);
  code = code.replace(/import ToolOutput from ['"]\.\/ToolOutput\.vue['"];?/, 'const ToolOutput = { render: () => null };');
  code = code.replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g, (_whole, _quote, path: string) => {
    const relative = path.endsWith('.js') ? path : `${path}.js`;
    return `from ${JSON.stringify(new URL(`../src/monitor/ui/${relative}`, import.meta.url).href)}`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).default;
}
const tool = (artifactId: string, operation = 'open', inputSchema: Record<string, unknown> = { type: 'object', additionalProperties: false }): MonitorHumanTool => ({
  name: `${operation}_${artifactId}`, artifactId, operation, description: `Inspect ${artifactId} in a desktop application.`, inputSchema,
});

test('rendered tool output displays text literally and only renders supported inline images', async t => {
  const host = node('root');
  const props = reactive({ result: { content: [
    { type: 'text', text: '<script>never execute</script>' },
    { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
    { type: 'image', path: '/etc/private.png', mimeType: 'image/png' },
    { type: 'image', data: '<svg onload="alert(1)">', mimeType: 'image/svg+xml' },
  ] }, canRead: false, canList: false, busy: false });
  const { app } = mount(await component('ToolOutput'), props, host); t.after(() => app.unmount());
  assert.match(text(host), /<script>never execute<\/script>/);
  assert.equal(all(host).some(child => child.type === 'script' || child.type === 'svg'), false);
  assert.deepEqual(all(host).filter(child => child.type === 'img').map(child => child.props.src), ['data:image/png;base64,aW1hZ2U=']);
  assert.equal(all(host).filter(child => child.type === 'p' && text(child).includes('cannot be displayed')).length, 2);
});
function detail(claimed: boolean, tools: MonitorHumanTool[] = [tool('spec'), tool('why')]): MonitorDetail {
  return {
    request: { id: 'request', projectId: 'project', status: 'WAITING_HUMAN', kind: 'human', claimedBy: claimed ? 'me' : null, waitingReason: null } as MonitorDetail['request'],
    profile: { kind: 'human' }, instruction: 'Review {spec} and {why}.',
    artifacts: [{ id: 'spec', type: 'text', path: 'spec.md' }, { id: 'why', type: 'text', path: 'why.md' }],
    tools, artifactPreview: 'tools', human: { canClaim: !claimed, claimedByMe: claimed, canComplete: claimed },
    result: null, error: null, timeline: [],
  };
}

test('Human instruction renders only scoped registered refs as buttons and keeps literal content safe', async t => {
  const selected: string[] = [], host = node('root');
  const props = reactive({ instruction: '{spec}\n{why} {outside} {{spec}} \\{spec} <script>bad()</script>',
    artifacts: [{ id: 'spec' }, { id: 'why' }], tools: [{ artifactId: 'spec' }], active: true,
    onArtifact: (artifactId: string) => selected.push(artifactId) });
  const { app } = mount(await component('ArtifactInstruction'), props, host); t.after(() => app.unmount());
  const buttons = all(host).filter(child => child.type === 'button');
  assert.equal(buttons.length, 1); assert.equal(buttons[0].props.type, 'button');
  assert.equal(buttons[0].props['aria-label'], 'Show Human tools for spec');
  buttons[0].props.onClick(); assert.deepEqual(selected, ['spec']);
  assert.match(text(host), /\nwhy \{outside\} \{\{spec\}\} \\\{spec\} <script>bad\(\)<\/script>/);
  assert.equal(all(host).some(child => child.type === 'script'), false);
  props.active = false; await nextTick();
  assert.equal(all(host).filter(child => child.type === 'button').length, 0, 'Completed references must not offer a dead action');
});

test('Human reference browsing exposes matching tools without claiming or executing; explicit actions retain claim gating', async t => {
  browserGlobals(t);
  const requests: string[] = [], host = node('root');
  const props = reactive({ detail: detail(false), session: { reviewerId: 'me', csrfToken: 'csrf' }, sessionError: '',
    onUpdated: (updated: MonitorDetail) => { props.detail = updated; } });
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input); requests.push(url);
    return new Response(JSON.stringify(url.endsWith('/claim') ? detail(true) : { result: { content: [{ type: 'launch', launched: true }] } }), { status: 200 });
  });
  const { app, view } = mount(await component('HumanReview'), props, host); t.after(() => app.unmount());
  view.showArtifactTools('why'); await nextTick();
  assert.equal(requests.length, 0); assert.match(text(host), /why · Available tools/); assert.match(text(host), /Claim the review/);
  assert.equal(all(host).filter(child => child.type === 'button').length, 1, 'Only the existing claim action is available before claim');
  await matching(host, 'button', 'Claim review').props.onClick(); await nextTick();
  assert.deepEqual(requests, ['/api/requests/project/request/claim']);
  view.showArtifactTools('why'); await nextTick();
  assert.equal(requests.length, 1, 'Selecting a reference must not launch its tool');
  assert.deepEqual(all(host).filter(child => child.type === 'button' && String(child.props.class).includes('artifact-choice')).map(text), ['why · Open']);
  matching(host, 'button', 'why · Open').props.onClick();
  await new Promise(resolve => setImmediate(resolve)); await nextTick();
  assert.deepEqual(requests, ['/api/requests/project/request/claim', '/api/requests/project/request/tools/open_why']);
});

test('refocusing the same Human Artifact preserves selected custom tool arguments and verdict drafts', async t => {
  browserGlobals(t);
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Reference navigation must not use the network'); });
  const host = node('root');
  const { app, view } = mount(await component('HumanReview'), { detail: detail(true, [tool('spec', 'preview', { type: 'object' }), tool('why')]), session: { reviewerId: 'me', csrfToken: 'csrf' }, sessionError: '' }, host); t.after(() => app.unmount());
  const textareas = all(host).filter(child => child.type === 'textarea');
  assert.equal(textareas.length, 3);
  textareas[0].props['onUpdate:modelValue']('{"camera":{"frame":17}}');
  textareas[1].props['onUpdate:modelValue']('Draft review summary');
  textareas[2].props['onUpdate:modelValue']('Observed evidence'); await nextTick();
  view.showArtifactTools('spec'); await nextTick(); view.showArtifactTools('spec'); await nextTick();
  assert.deepEqual(all(host).filter(child => child.type === 'textarea').map(child => child.value), ['{"camera":{"frame":17}}', 'Draft review summary', 'Observed evidence']);
  assert.equal(calls, 0);
  assert.equal(matching(host, 'button', 'spec · preview').props['aria-pressed'], true);
  view.showArtifactTools('outside'); await nextTick();
  assert.match(text(host), /spec · Available tools/); assert.equal(calls, 0);
});

test('Human Claim displays preparation phases and stops waiting when its attempt is released', async t => {
  browserGlobals(t);
  let clock = Date.UTC(2026, 8, 11, 7), tick = () => {};
  let claimSignal: AbortSignal | null | undefined;
  let finishClaim = (_response: Response) => {};
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(globalThis, 'setInterval', (callback: () => void) => { tick = callback; return 0; });
  const host = node('root');
  const props = reactive({ detail: detail(false), session: { reviewerId: 'me', csrfToken: 'csrf' }, sessionError: '',
    onUpdated: (updated: MonitorDetail) => { props.detail = updated; } });
  t.mock.method(globalThis, 'fetch', (_url: unknown, options: RequestInit) => new Promise<Response>((resolve, reject) => {
    claimSignal = options.signal;
    finishClaim = resolve;
    options.signal?.addEventListener('abort', () => reject(new Error('Claim connection closed')), { once: true });
  }));
  const { app } = mount(await component('HumanReview'), props, host); t.after(() => app.unmount());
  const pending = matching(host, 'button', 'Claim review').props.onClick();
  await nextTick();
  const startedAt = new Date(Date.now() - 12000).toISOString();
  const attempt = { id: 'attempt-one', reviewerId: 'me', preparingByMe: true, status: 'preparing',
    startedAt, expiresAt: new Date(Date.now() + 120000).toISOString(), heartbeatAt: startedAt,
    phase: 'checking-environment', phaseStartedAt: startedAt, timings: [], elapsedMs: 12000, phaseElapsedMs: 12000 };
  props.detail = { ...detail(false), human: { canClaim: false, claimedByMe: false, canComplete: false,
    preparation: attempt } } as MonitorDetail;
  await nextTick();
  assert.match(text(host), /Checking environment requirements/);
  assert.match(text(host), /attempt-one/);
  assert.match(text(host), /Elapsed.*12s/);
  assert.match(text(host), /Last heartbeat/);
  clock += 121000; tick(); await nextTick();
  assert.match(text(host), /Awaiting preparation update/);
  assert.equal(claimSignal?.aborted, false, 'A stale GET record must not cancel a lease renewed by the server');
  props.detail = { ...detail(false), human: { ...detail(false).human!, preparation: {
    ...attempt, status: 'released', completedAt: new Date().toISOString(),
  } } } as MonitorDetail;
  await nextTick();
  assert.match(text(host), /Preparation released/);
  assert.doesNotMatch(text(host), /Preparing…/);
  assert.equal(matching(host, 'button', 'Claim review').props.disabled, false);
  assert.equal(claimSignal?.aborted, false, 'Keep the released attempt response available for its diagnostic');
  finishClaim(Response.json({ error: 'Install the missing viewer runtime.' }, { status: 409 }));
  await pending; await nextTick();
  assert.match(text(host), /Install the missing viewer runtime/);
  assert.doesNotMatch(text(host), /Claim connection closed/);

  const retry = matching(host, 'button', 'Claim review').props.onClick();
  props.detail = { ...detail(false), human: { canClaim: false, claimedByMe: false, canComplete: false,
    preparation: { ...attempt, id: 'attempt-two', previousAttemptId: 'attempt-one', phase: 'final-validation', expiresAt: new Date(Date.now() + 120000).toISOString() } } } as MonitorDetail;
  await nextTick();
  assert.match(text(host), /Final input validation/);
  assert.match(text(host), /attempt-two/);
  assert.match(text(host), /Replaces attempt attempt-one/);
  props.detail = { ...props.detail, human: { ...props.detail.human!, preparation: {
    ...props.detail.human!.preparation!, id: 'attempt-three', previousAttemptId: 'attempt-two',
  } } };
  await nextTick(); await retry; await nextTick();
  assert.match(text(host), /attempt-three/);
  assert.doesNotMatch(text(host), /Claim connection closed/);
});

test('Human Claim renders expired and confirmed attempts without an indefinite preparation spinner', async t => {
  browserGlobals(t);
  let clock = Date.UTC(2026, 8, 11, 7), tick = () => {};
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(globalThis, 'setInterval', (callback: () => void) => { tick = callback; return 0; });
  const host = node('root'), startedAt = new Date(Date.now() - 180000).toISOString();
  const attempt = { id: 'expired-attempt', reviewerId: 'me', preparingByMe: true, status: 'preparing',
    startedAt, expiresAt: new Date(Date.now() + 1000).toISOString(), heartbeatAt: startedAt,
    phase: 'validating-input', phaseStartedAt: startedAt, timings: [], elapsedMs: 180000, phaseElapsedMs: 180000 };
  const props = reactive({ detail: { ...detail(false), human: { ...detail(false).human!, preparation: attempt } } as MonitorDetail,
    session: { reviewerId: 'me', csrfToken: 'csrf' }, sessionError: '' });
  const { app } = mount(await component('HumanReview'), props, host); t.after(() => app.unmount());
  assert.match(text(host), /Validating fixed input/);
  assert.match(text(host), /No recent preparation heartbeat/);
  clock += 2000; tick(); await nextTick();
  assert.match(text(host), /Awaiting preparation update/);
  assert.doesNotMatch(text(host), /Preparation expired/);
  props.detail = { ...detail(false), human: { ...detail(false).human!, preparation: { ...attempt, status: 'expired' } } } as MonitorDetail;
  await nextTick();
  assert.match(text(host), /Preparation expired/);
  assert.match(text(host), /Claim review/);
  assert.doesNotMatch(text(host), /Preparing…/);
  props.detail = { ...detail(true), human: { ...detail(true).human!, preparation: {
    ...attempt, status: 'claimed', completedAt: new Date().toISOString(),
    timings: [{ phase: 'validating-input', startedAt, completedAt: new Date().toISOString(), durationMs: 75000 }],
  } } } as MonitorDetail;
  await nextTick();
  assert.match(text(host), /Assignment confirmed/);
  assert.match(text(host), /Assigned to me/);
  assert.match(text(host), /Validating fixed input.*1m 15s/);
  assert.doesNotMatch(text(host), /Preparing…/);
});

test('Human group references expose deduplicated scoped member tools and preserve claim gating', async t => {
  browserGlobals(t);
  const artifactGroups = [{ id: 'documents', members: ['spec', 'why'] }, { id: 'bundle', members: ['documents', 'spec'] }];
  const instructionHost = node('root'), selected: string[] = [];
  const instruction = mount(await component('ArtifactInstruction'), {
    instruction: 'Review: {bundle} and {outside}', artifacts: [{ id: 'spec' }, { id: 'why' }], artifactGroups,
    tools: [tool('spec'), tool('why'), tool('outside')], active: true, onArtifact: (id: string) => selected.push(id),
  }, instructionHost);
  t.after(() => instruction.app.unmount());
  const reference = matching(instructionHost, 'button', 'bundle');
  reference.props.onClick(); assert.deepEqual(selected, ['bundle']);
  assert.equal(all(instructionHost).filter(child => child.type === 'button').length, 1);
  assert.match(text(instructionHost), /\{outside\}/);

  const host = node('root'), requests: string[] = [];
  const groupedDetail = (claimed: boolean): MonitorDetail => ({ ...detail(claimed, [tool('spec'), tool('why'), tool('outside')]), artifactGroups });
  const props = reactive({ detail: groupedDetail(false), session: { reviewerId: 'me', csrfToken: 'csrf' }, sessionError: '',
    onUpdated: (updated: MonitorDetail) => { props.detail = updated; } });
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input); requests.push(url);
    return new Response(JSON.stringify(url.endsWith('/claim') ? groupedDetail(true) : { result: { content: [{ type: 'launch', launched: true }] } }), { status: 200 });
  });
  const { app, view } = mount(await component('HumanReview'), props, host); t.after(() => app.unmount());
  view.showArtifactTools('bundle'); await nextTick();
  assert.equal(requests.length, 0); assert.match(text(host), /bundle · Available tools/);
  assert.match(text(host), /Claim the review/); assert.doesNotMatch(text(host), /outside/);
  await matching(host, 'button', 'Claim review').props.onClick(); await nextTick();
  view.showArtifactTools('bundle'); await nextTick();
  const buttons = all(host).filter(child => child.type === 'button' && String(child.props.class).includes('artifact-choice'));
  assert.deepEqual(buttons.map(text), ['spec · Open', 'why · Open']);
  assert.equal(requests.length, 1, 'Choosing a group only focuses the provided tools');
  matching(host, 'button', 'why · Open').props.onClick();
  await new Promise(resolve => setImmediate(resolve)); await nextTick();
  assert.deepEqual(requests, ['/api/requests/project/request/claim', '/api/requests/project/request/tools/open_why']);
});

test('Human form and JSON submission preserve typed arguments and reject invalid input before HTTP', async t => {
  browserGlobals(t);
  const sent: unknown[] = [], host = node('root');
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    sent.push(JSON.parse(String(options.body)).arguments);
    return Response.json({ result: { content: [] } });
  });
  const schema = { type: 'object', properties: {
    frame: { type: 'integer', minimum: 0 }, time: { type: 'number', minimum: 0, maximum: 1 },
    enabled: { type: 'boolean', default: false }, mode: { enum: [1, '1', null] }, label: { type: 'string' },
    optional: { type: 'integer' },
  }, required: ['frame', 'time', 'enabled', 'mode', 'label'], additionalProperties: false };
  const { app } = mount(await component('HumanReview'), { detail: detail(true, [tool('spec', 'preview', schema)]),
    session: { reviewerId: 'me', csrfToken: 'csrf' }, sessionError: '' }, host); t.after(() => app.unmount());
  for (const [label, value] of Object.entries({ frame: '2', time: '0.125', label: '  clip  ' })) {
    const field = all(matching(host, 'label', label)).find(child => child.type === 'input')!;
    field.props.onInput({ target: Object.assign(new HTMLInputElement(), { value }) });
  }
  all(matching(host, 'label', 'mode')).find(child => child.type === 'select')!.props['onUpdate:modelValue']('1');
  await nextTick();
  const submit = async () => {
    all(host).find(child => child.type === 'form')!.props.onSubmit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve)); await nextTick();
  };
  await submit();
  const expected = { frame: 2, time: 0.125, enabled: false, mode: '1', label: '  clip  ' };
  assert.deepEqual(sent, [expected]);
  matching(host, 'button', 'Enter JSON').props.onClick(); await nextTick();
  const input = all(host).find(child => child.type === 'textarea')!;
  input.props['onUpdate:modelValue'](JSON.stringify({ ...expected, enabled: 'false' }));
  await nextTick(); await submit();
  assert.equal(sent.length, 1);
  input.props['onUpdate:modelValue'](JSON.stringify({ ...expected, mode: null }));
  await nextTick(); await submit();
  assert.deepEqual(sent[1], { ...expected, mode: null });
});

test('rendered Critic status distinguishes omitted, claimed, blocked, failed and reused reviews', async t => {
  browserGlobals(t);
  const host = node('root'); let opened = 0;
  const base: GraphCriticState = { id: 'human-check', title: 'Review documents', target: 'spec', deps: ['why'],
    kind: 'human', requestId: 'request', status: 'WAITING_HUMAN', claimedBy: null, blockedReason: null };
  const props = reactive({ critic: { ...base }, request: undefined as MonitorRequest | undefined, onOpen: () => { opened++; } });
  const { app } = mount(await component('CriticStatusIcon'), props, host);
  try {
    const cases: [Partial<GraphCriticState>, string, RegExp, boolean][] = [
      [{}, 'requested', /Awaiting reviewer/, false],
      [{ claimedBy: 'reviewer' }, 'running', /Reviewer working/, false],
      [{ requestId: null, status: null }, 'omitted', /Not included/, true],
      [{ status: 'BLOCKED' }, 'requested', /Awaiting dependencies/, false],
      [{ status: 'RED' }, 'failure', /Criteria not met/, false],
      [{ status: 'ERROR' }, 'failure', /Execution error/, false],
      [{ status: null, requestId: null, validationStatus: 'STALE' }, 'requested', /Needs revalidation/, true],
      [{ validationStatus: 'BLOCKED' }, 'requested', /Dependencies need validation/, false],
      [{ status: 'GREEN', validationStatus: 'PASS', reusedFrom: { requestId: 'previous', runId: 'previous-run', completedAt: '2026-01-01T00:00:00.000Z' } }, 'success', /Previous verdict reused/, false],
    ];
    for (const [changes, state, label, disabled] of cases) {
      props.critic = { ...base, ...changes }; await nextTick();
      const button = all(host).find(child => child.type === 'button')!;
      assert.equal(button.props['data-state'], state);
      assert.match(button.props['aria-label'], label);
      assert.equal(button.props['aria-disabled'], disabled);
    }
    all(host).find(child => child.type === 'button')!.props.onClick({ stopPropagation() {} });
    assert.equal(opened, 1, 'Reused evidence remains inspectable');
    props.critic = { ...base, status: 'BLOCKED' };
    props.request = { id: 'request', criticId: base.id, blockedByFailure: true } as MonitorRequest;
    await nextTick();
    const blocked = all(host).find(child => child.type === 'button')!;
    assert.equal(blocked.props['data-state'], 'requested');
    assert.match(blocked.props['aria-label'], /Blocked.*Dependency failed/);
  } finally { app.unmount(); }
});
