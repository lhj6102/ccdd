import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import ElkApi from 'elkjs/lib/elk-api.js';
import type { ELK, ELKConstructorArguments, ElkNode } from 'elkjs/lib/elk-api.js';

test('the emitted browser worker completes real ELK API registration and layout', { timeout: 12_000 }, async t => {
  const directory = new URL('../monitor-ui/assets/', import.meta.url);
  const assets = (await readdir(directory)).filter(name => /^graph-layout-worker-.+\.js$/.test(name));
  assert.equal(assets.length, 1, 'The production build must emit one local layout worker.');
  const source = await readFile(new URL(assets[0], directory), 'utf8');
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const commands: string[] = [], replies: unknown[] = [];
  let terminated = false;
  const worker = {
    onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
    postMessage(message: { cmd: string }): void {
      commands.push(message.cmd);
      // A real Worker reconstructs incoming values in its own realm. This also
      // gives the emitted engine a genuine self global, unlike its Node fallback.
      context.messageJSON = JSON.stringify(message);
      runInContext('onmessage({ data: JSON.parse(messageJSON) })', context, { timeout: 5_000 });
    },
    terminate(): void {
      terminated = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
  const context = createContext({
    console,
    postMessage(message: unknown): void {
      replies.push(structuredClone(message));
      queueMicrotask(() => { if (!terminated) worker.onmessage?.({ data: structuredClone(message) }); });
    },
    setTimeout(callback: () => void, delay = 0): ReturnType<typeof setTimeout> {
      const timer = setTimeout(() => { timers.delete(timer); if (!terminated) callback(); }, delay);
      timers.add(timer); return timer;
    },
    clearTimeout(timer: ReturnType<typeof setTimeout>): void { timers.delete(timer); clearTimeout(timer); },
  });
  context.self = context;
  t.after(() => worker.terminate());
  runInContext(source, context, { timeout: 5_000, filename: assets[0] });
  assert.equal(typeof context.onmessage, 'function', 'The worker must install the ELK message handler.');

  const Elk = ElkApi as unknown as new (options: ELKConstructorArguments) => ELK;
  const elk = new Elk({ algorithms: ['layered'], workerFactory: () => worker as unknown as ReturnType<NonNullable<ELKConstructorArguments['workerFactory']>> });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  t.after(() => clearTimeout(timeout));
  const layout = await Promise.race([
    elk.layout<ElkNode>({
      id: 'root', layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT' },
      children: [{ id: 'source', width: 208, height: 114 }, { id: 'target', width: 208, height: 148 }],
      edges: [{ id: 'dependency', sources: ['source'], targets: ['target'] }],
    }),
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`Emitted worker did not complete the ELK protocol: ${JSON.stringify(replies)}`)), 5_000);
    }),
  ]);
  assert.deepEqual(commands, ['register', 'layout']);
  const nodes = new Map(layout.children?.map(node => [node.id, node]));
  assert.equal(nodes.size, 2);
  const from = nodes.get('source')!, to = nodes.get('target')!;
  assert.ok(Number.isFinite(from.x) && Number.isFinite(to.x));
  assert.ok(from.x! + from.width! < to.x!, 'The actual worker must produce a forward dependency layout.');
  const edge = layout.edges?.find(edge => edge.id === 'dependency');
  assert.equal(edge?.sections?.length, 1);
  assert.ok(edge!.sections![0].endPoint.x > edge!.sections![0].startPoint.x);
  elk.terminateWorker();
  assert.equal(terminated, true);
});
