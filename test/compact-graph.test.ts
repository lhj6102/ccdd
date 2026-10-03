import test from 'node:test';
import assert from 'node:assert/strict';
import { compactGraphDefinition, projectGraph, type GraphDefinition } from '../src/broker/graph.js';
import { familyPage, FAMILY_PAGE_SIZE, FAMILY_GRAPH_EXPANSION_LIMIT } from '../src/monitor/ui/family-pagination.js';
import { artifactFixture } from './helpers/artifacts.js';
import { main } from '../src/project/cli.js';

function graph(count: number): GraphDefinition {
  const ids = Array.from({ length: count }, (_, i) => `item-${i}`);
  return { version: 2, artifacts: Object.fromEntries(ids.map(id => [id, {
    name: id, path: 'family', mounts: {}, children: {}, family: { name: 'catalog', entry: '0'.repeat(64), material: [] },
    views: { agentTools: { read: { metadata: { description: 'x'.repeat(12000), inputSchema: { type: 'object' }, resultKinds: ['text'], observation: 'content' }, script: { command: 'node', args: ['read.mjs'] } } } },
  }])), critics: ids.map(id => ({ id: `${id}/review`, title: 'Review', target: id, deps: [], kind: 'human' })), relations: [] };
}
test('compact graph preserves all 2000 instances and Critics without repeated execution definitions', t => {
  const original = graph(2000), compact = compactGraphDefinition(original);
  assert.equal(compact.artifacts.length, 2000); assert.equal(compact.critics.length, 2000);
  assert.deepEqual(compact.critics, original.critics); assert.deepEqual(compact.relations, original.relations);
  const fullBytes = Buffer.byteLength(JSON.stringify(original)), compactBytes = Buffer.byteLength(JSON.stringify(compact));
  assert.ok(compactBytes < fullBytes / 10);
  t.diagnostic(`2000 Artifacts: full=${fullBytes} bytes, compact=${compactBytes} bytes, reduction=${(100*(1-compactBytes/fullBytes)).toFixed(2)}%.`);
  assert.ok(!JSON.stringify(compact).includes('inputSchema'));
  compact.critics[0].deps.push('changed'); assert.equal(original.critics[0].deps.length, 0);
  const projection = projectGraph(original, []); assert.equal(projection.artifacts[1999].criticIds[0], 'item-1999/review');
});
test('family pagination bounds the DOM list without hiding any of 2001 members', () => {
  const members = Array.from({ length: 2001 }, (_, i) => i), first = familyPage(members, 0);
  assert.equal(first.items.length, FAMILY_PAGE_SIZE); assert.equal(first.pages, 21);
  assert.deepEqual(Array.from({ length: first.pages }, (_, i) => familyPage(members, i).items).flat(), members);
  assert.equal(familyPage(members, 1e9).items.length, 1);
  assert.equal(familyPage(members, -1).page, 0); assert.equal(familyPage([], 0).pages, 1);
  assert.ok(members.length > FAMILY_GRAPH_EXPANSION_LIMIT);
});
test('graph --compact is opt-in and static, while the original JSON format remains available', async t => {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', critics: [{ id: 'review', title: 'Review', profile: { kind: 'human' }, payload: { instruction: 'Inspect {a}.' } }] });
  for (const compact of [false, true]) {
    let out = '', err = '';
    const code = await main(['graph', '--repo', data.repoPath, '--state-dir', data.stateDir, '--json', ...(compact ? ['--compact'] : [])], {
      stdout: { write(v: string) { out += v; } }, stderr: { write(v: string) { err += v; } },
    });
    assert.equal(code, 0, err); const result = JSON.parse(out);
    if (compact) { assert.equal(result.projection, 'compact'); assert.equal(result.artifacts[0].id, 'a'); }
    else { assert.equal(result.version, 2); assert.ok(result.artifacts.a.views); }
  }
});
