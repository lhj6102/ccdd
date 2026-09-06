import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { compileScript, parse } from 'vue/compiler-sfc';
import { createRenderer, h, nextTick, reactive, ref } from 'vue';
import type { Component } from 'vue';
import type { MonitorDetail, MonitorHumanTool } from '../src/monitor/types.js';
// Include the SFC's runtime helpers in the normal test compilation.
import '../src/monitor/ui/api.js';
import '../src/monitor/ui/tool-input.js';

type Node = {
  type: string; text: string; props: Record<string, any>; children: Node[]; parent: Node | null;
  value: unknown; checked: boolean; tagName: string;
  focus(): void; scrollIntoView(): void; addEventListener(): void; removeEventListener(): void;
  querySelector(): null; getRootNode(): typeof documentState;
};
const documentState = { activeElement: null as Node | null };
function browserGlobals(t: TestContext): void {
  for (const [key, value] of Object.entries({ document: documentState, Document: class {}, ShadowRoot: class {} })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
}
function node(type: string, text = ''): Node {
  return { type, text, props: {}, children: [], parent: null, value: '', checked: false, tagName: type.toUpperCase(),
    focus() { documentState.activeElement = this; }, scrollIntoView() {}, addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, getRootNode() { return documentState; } };
}
const renderer = createRenderer<Node, Node>({
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
  code = code.replace(/import ToolOutput from ['"]\.\/ToolOutput\.vue['"];?/, 'const ToolOutput = { render: () => null };');
  code = code.replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g, (_whole, _quote, path: string) => {
    const relative = path.endsWith('.js') ? path : `${path}.js`;
    return `from ${JSON.stringify(new URL(`../src/monitor/ui/${relative}`, import.meta.url).href)}`;
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).default;
}
const tool = (artifactId: string, operation = 'open', inputSchema: Record<string, unknown> = { type: 'object', additionalProperties: false }): MonitorHumanTool => ({
  name: `${operation}_${artifactId}`, artifactId, operation, description: `${artifactId}을 데스크톱에서 확인합니다.`, inputSchema,
});
function detail(claimed: boolean, tools: MonitorHumanTool[] = [tool('spec'), tool('why')]): MonitorDetail {
  return {
    request: { id: 'request', projectId: 'project', status: 'WAITING_HUMAN', kind: 'human', claimedBy: claimed ? 'me' : null, waitingReason: null } as MonitorDetail['request'],
    profile: { kind: 'human' }, instruction: '{spec}과 {why}을 검토하세요.',
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
  assert.equal(buttons[0].props['aria-label'], 'spec의 Human 도구 보기');
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
  assert.equal(requests.length, 0); assert.match(text(host), /why · 제공된 도구/); assert.match(text(host), /검토를 맡은 후/);
  assert.equal(all(host).filter(child => child.type === 'button').length, 1, 'Only the existing claim action is available before claim');
  await matching(host, 'button', '맡아서 검토').props.onClick(); await nextTick();
  assert.deepEqual(requests, ['/api/requests/project/request/claim']);
  view.showArtifactTools('why'); await nextTick();
  assert.equal(requests.length, 1, 'Selecting a reference must not launch its tool');
  assert.deepEqual(all(host).filter(child => child.type === 'button' && String(child.props.class).includes('artifact-choice')).map(text), ['why · 열기']);
  matching(host, 'button', 'why · 열기').props.onClick();
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
  textareas[1].props['onUpdate:modelValue']('검토 중인 요약');
  textareas[2].props['onUpdate:modelValue']('확인한 근거'); await nextTick();
  view.showArtifactTools('spec'); await nextTick(); view.showArtifactTools('spec'); await nextTick();
  assert.deepEqual(all(host).filter(child => child.type === 'textarea').map(child => child.value), ['{"camera":{"frame":17}}', '검토 중인 요약', '확인한 근거']);
  assert.equal(calls, 0);
  assert.equal(matching(host, 'button', 'spec · preview').props['aria-pressed'], true);
  view.showArtifactTools('outside'); await nextTick();
  assert.match(text(host), /spec · 제공된 도구/); assert.equal(calls, 0);
});
