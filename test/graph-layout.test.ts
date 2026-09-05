import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph, type LayoutGraphInput } from '../src/monitor/ui/graph-layout.js';

const input: LayoutGraphInput = {
  artifacts: ['why', 'policy', 'spec', 'tests', 'implementation'].map(id => ({ id })),
  edges: [
    { source: 'why', target: 'spec', criticIds: ['alignment'] },
    { source: 'policy', target: 'spec', criticIds: ['alignment'] },
    { source: 'spec', target: 'tests', criticIds: ['tests-spec'] },
    { source: 'tests', target: 'implementation', criticIds: ['runtime'] },
    { source: 'spec', target: 'implementation', criticIds: ['implementation-spec'] },
    { source: 'why', target: 'spec', criticIds: ['independent-alignment', 'alignment'] },
  ],
};

test('Artifact layout ranks a DAG with multiple parents and deduplicates shared Critic relations', () => {
  const layout = layoutGraph(input);
  const positions = new Map(layout.nodes.map(node => [node.id, node]));
  assert.equal(layout.nodes.length, 5);
  assert.equal(layout.edges.length, 5);
  assert.deepEqual(layout.edges.find(edge => edge.source === 'why' && edge.target === 'spec')?.criticIds, ['alignment', 'independent-alignment']);
  assert.equal(positions.get('why')!.x, positions.get('policy')!.x);
  for (const edge of layout.edges) assert.ok(positions.get(edge.source)!.x + positions.get(edge.source)!.width < positions.get(edge.target)!.x);
  for (const [index, node] of layout.nodes.entries()) {
    assert.ok(node.x >= 0 && node.y >= 0 && node.x + node.width <= layout.width && node.y + node.height <= layout.height);
    for (const other of layout.nodes.slice(index + 1)) assert.ok(node.x + node.width <= other.x || other.x + other.width <= node.x || node.y + node.height <= other.y || other.y + other.height <= node.y, 'Artifact boxes must not overlap.');
  }
});

test('request status changes and edge enumeration order do not move snapshot topology', () => {
  const changed = { ...input, artifacts: input.artifacts.map((artifact, index) => ({ ...artifact, status: index % 2 ? 'WAITING_HUMAN' : 'GREEN' })), edges: [...input.edges].reverse() };
  assert.deepEqual(layoutGraph(changed).nodes, layoutGraph(input).nodes);
  assert.deepEqual(layoutGraph(changed).edges.map(edge => edge.path), layoutGraph(input).edges.map(edge => edge.path));
});

test('mobile layout flows downwards, keeps a linear graph narrow, and handles branch convergence', () => {
  const layout = layoutGraph(input, true), nodes = new Map(layout.nodes.map(node => [node.id, node]));
  for (const edge of layout.edges) assert.ok(nodes.get(edge.source)!.y + nodes.get(edge.source)!.height < nodes.get(edge.target)!.y);
  const linear = layoutGraph({ artifacts: ['a', 'b', 'c', 'd'].map(id => ({ id })), edges: [{ source: 'a', target: 'b', criticIds: ['one'] }, { source: 'b', target: 'c', criticIds: ['two'] }, { source: 'c', target: 'd', criticIds: ['three'] }] }, true);
  assert.ok(linear.width < 320, 'A phone-sized single chain should not require horizontal panning.');
  assert.equal(new Set(linear.nodes.map(node => node.x)).size, 1);
});

test('edges that skip layers leave through gutters and stay outside intervening Artifact boxes', () => {
  const graph = { artifacts: ['a', 'peer', 'b', 'c'].map(id => ({ id })), edges: [{ source: 'a', target: 'b', criticIds: ['one'] }, { source: 'b', target: 'c', criticIds: ['two'] }, { source: 'a', target: 'c', criticIds: ['three'] }] };
  for (const vertical of [false, true]) {
    const layout = layoutGraph(graph, vertical), edge = layout.edges.find(candidate => candidate.source === 'a' && candidate.target === 'c')!;
    const numbers = edge.path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    assert.equal(numbers.length, 7);
    const [x, y, lead, outer, end, targetPeer, final] = numbers;
    const points = vertical ? [[x, y], [x, lead], [outer, lead], [outer, end], [targetPeer, end], [targetPeer, final]] : [[x, y], [lead, y], [lead, outer], [end, outer], [end, targetPeer], [final, targetPeer]];
    for (let index = 1; index < points.length; index++) {
      const [ax, ay] = points[index - 1], [bx, by] = points[index];
      for (const node of layout.nodes) {
        const crosses = ax === bx ? ax > node.x && ax < node.x + node.width && Math.max(ay, by) > node.y && Math.min(ay, by) < node.y + node.height : ay > node.y && ay < node.y + node.height && Math.max(ax, bx) > node.x && Math.min(ax, bx) < node.x + node.width;
        assert.equal(crosses, false, `Long edge crossed ${node.id}.`);
      }
    }
  }
});

test('invalid graph relations fail explicitly instead of producing misleading positions', () => {
  assert.throws(() => layoutGraph({ artifacts: [{ id: 'a' }], edges: [{ source: 'a', target: 'missing', criticIds: [] }] }), /unknown/);
  assert.throws(() => layoutGraph({ artifacts: [{ id: 'a' }, { id: 'a' }], edges: [] }), /Duplicate/);
  assert.throws(() => layoutGraph({ artifacts: [{ id: 'a' }], edges: [{ source: 'a', target: 'a', criticIds: [] }] }), /cycle/);
  assert.throws(() => layoutGraph({ artifacts: [{ id: 'a' }, { id: 'b' }], edges: [{ source: 'a', target: 'b', criticIds: [] }, { source: 'b', target: 'a', criticIds: [] }] }), /cycle/);
  assert.deepEqual(layoutGraph({ artifacts: [], edges: [] }).nodes, []);
});
