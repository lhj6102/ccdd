import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph, type GraphLayout, type GraphPoint, type LayoutGraphInput } from '../src/monitor/ui/graph-layout.js';

const input: LayoutGraphInput = {
  artifacts: ['why', 'policy', 'spec', 'tests', 'implementation'].map(id => ({ id, criticIds: id === 'spec' ? ['alignment', 'human'] : [] })),
  edges: [
    { source: 'why', target: 'spec', criticIds: ['alignment'] },
    { source: 'policy', target: 'spec', criticIds: ['alignment'] },
    { source: 'spec', target: 'tests', criticIds: ['tests-spec'] },
    { source: 'tests', target: 'implementation', criticIds: ['runtime'] },
    { source: 'spec', target: 'implementation', criticIds: ['implementation-spec'] },
    { source: 'why', target: 'spec', criticIds: ['independent-alignment', 'alignment'] },
  ],
};

function assertGeometry(layout: GraphLayout, vertical = false): void {
  const positions = new Map(layout.nodes.map(node => [node.id, node]));
  for (const [index, node] of layout.nodes.entries()) {
    assert.ok(node.x >= 0 && node.y >= 0 && node.x + node.width <= layout.width && node.y + node.height <= layout.height);
    for (const other of layout.nodes.slice(index + 1)) {
      assert.ok(node.x + node.width <= other.x || other.x + other.width <= node.x || node.y + node.height <= other.y || other.y + other.height <= node.y, `Artifacts ${node.id} and ${other.id} overlap.`);
    }
  }
  for (const edge of layout.edges) {
    const source = positions.get(edge.source)!, target = positions.get(edge.target)!;
    assert.ok(vertical ? source.y + source.height < target.y : source.x + source.width < target.x, 'Every dependency must flow forward.');
    assert.deepEqual(edge.points[0], { x: source.x + source.sourcePort.x, y: source.y + source.sourcePort.y });
    assert.deepEqual(edge.points.at(-1), { x: target.x + target.targetPort.x, y: target.y + target.targetPort.y });
    for (const point of [...edge.points, ...samplePath(edge.path), { x: edge.labelX, y: edge.labelY }]) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
      assert.ok(point.x >= 0 && point.y >= 0 && point.x <= layout.width && point.y <= layout.height, 'Routes and curves remain in the canvas.');
      for (const node of layout.nodes) {
        assert.equal(point.x > node.x + 0.01 && point.x < node.x + node.width - 0.01 && point.y > node.y + 0.01 && point.y < node.y + node.height - 0.01, false, `${edge.source} → ${edge.target} crosses ${node.id}.`);
      }
    }
  }
}

// Sample the rendered SVG commands rather than assuming that ELK's polyline and
// the softened curve have identical geometry. This also catches unsafe shortcuts.
function samplePath(path: string): GraphPoint[] {
  const commands = path.match(/[MLQC][^MLQC]*/g)!;
  let current = { x: 0, y: 0 };
  const points: GraphPoint[] = [];
  for (const command of commands) {
    const values = command.slice(1).trim().split(/\s+/).map(Number);
    const next = { x: values.at(-2)!, y: values.at(-1)! };
    if (command[0] === 'M') { current = next; points.push(next); continue; }
    for (let step = 0; step <= 100; step++) {
      const t = step / 100, s = 1 - t;
      if (command[0] === 'C') points.push({ x: s ** 3 * current.x + 3 * s ** 2 * t * values[0] + 3 * s * t ** 2 * values[2] + t ** 3 * next.x, y: s ** 3 * current.y + 3 * s ** 2 * t * values[1] + 3 * s * t ** 2 * values[3] + t ** 3 * next.y });
      else if (command[0] === 'Q') points.push({ x: s ** 2 * current.x + 2 * s * t * values[0] + t ** 2 * next.x, y: s ** 2 * current.y + 2 * s * t * values[1] + t ** 2 * next.y });
      else points.push({ x: s * current.x + t * next.x, y: s * current.y + t * next.y });
    }
    current = next;
  }
  return points;
}

test('ELK lays out multiple parents and shared Critic relations without node or route overlap', async () => {
  const layout = await layoutGraph(input);
  assert.equal(layout.nodes.length, 5);
  assert.equal(layout.edges.length, 5);
  assert.deepEqual(layout.edges.find(edge => edge.source === 'why' && edge.target === 'spec')?.criticIds, ['alignment', 'independent-alignment']);
  assertGeometry(layout);
  assertGeometry(await layoutGraph(input, true), true);
});

test('invalid graphs and cancelled layout fail explicitly, while empty graphs remain valid', async () => {
  await assert.rejects(layoutGraph({ artifacts: [{ id: 'a' }], edges: [{ source: 'a', target: 'missing', criticIds: [] }] }), /unknown/);
  await assert.rejects(layoutGraph({ artifacts: [{ id: 'a' }, { id: 'a' }], edges: [] }), /Duplicate/);
  await assert.rejects(layoutGraph({ artifacts: [{ id: 'a' }], edges: [{ source: 'a', target: 'a', criticIds: [] }] }), /cycle/);
  await assert.rejects(layoutGraph({ artifacts: [{ id: 'a' }, { id: 'b' }], edges: [{ source: 'a', target: 'b', criticIds: [] }, { source: 'b', target: 'a', criticIds: [] }] }), /cycle/);
  await assert.rejects(layoutGraph(input, false, AbortSignal.abort()), { name: 'AbortError' });
  assert.deepEqual((await layoutGraph({ artifacts: [], edges: [] })).nodes, []);
});

test('pending browser workers terminate on cancellation, worker error, and message failure', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  let created: (worker: ControlledWorker) => void;
  const nextWorker = (): Promise<ControlledWorker> => new Promise(resolve => { created = resolve; });
  class ControlledWorker {
    onerror?: () => void;
    onmessageerror?: () => void;
    terminated = 0;
    constructor() { created(this); }
    postMessage(): void {}
    terminate(): void { this.terminated++; }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: ControlledWorker });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'Worker', original); else Reflect.deleteProperty(globalThis, 'Worker'); });

  const controller = new AbortController();
  const cancelWorkerReady = nextWorker();
  const cancelled = assert.rejects(layoutGraph(input, false, controller.signal), { name: 'AbortError' });
  const cancelWorker = await cancelWorkerReady;
  controller.abort();
  await cancelled;
  assert.equal(cancelWorker.terminated, 1, 'Switching graphs or unmounting must immediately release the old worker.');

  const failureWorkerReady = nextWorker();
  const failed = assert.rejects(layoutGraph(input), /worker failed/);
  const failureWorker = await failureWorkerReady;
  failureWorker.onerror!();
  await failed;
  assert.equal(failureWorker.terminated, 1);

  const messageWorkerReady = nextWorker();
  const unreadable = assert.rejects(layoutGraph(input), /could not be read/);
  const messageWorker = await messageWorkerReady;
  messageWorker.onmessageerror!();
  await unreadable;
  assert.equal(messageWorker.terminated, 1);
});
