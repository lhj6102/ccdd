import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraphDefinition, projectGraph, prerequisiteCriticIds, validateGraphDefinition, type GraphRequest } from '../src/broker/graph.js';
import type { RepoConfig } from '../src/contracts.js';

function config(): RepoConfig {
  const profile = { kind: 'human' } as const;
  const critic = (id: string, target: string, deps: string[]) => ({ id, title: id, target, deps, profile, payload: { instruction: 'Review the target.' } });
  return {
    artifacts: { why: { type: 'text', path: 'why.md', basis: true }, spec: { type: 'text', path: 'spec.md' }, tests: { type: 'text', path: 'tests.md' }, implementation: { type: 'text', path: 'implementation.md' }, notes: { type: 'text', path: 'notes.md' } },
    artifactTypes: { text: { viewer: 'text', humanTools: { read: {} } } },
    critics: [critic('implementation', 'implementation', ['spec', 'tests']), critic('tests', 'tests', ['spec']), critic('spec-policy', 'spec', ['why']), critic('spec-style', 'spec', []), critic('spec-second-opinion', 'spec', ['why'])],
  };
}
function requests(configuration: RepoConfig): GraphRequest[] { return configuration.critics.map(critic => ({ id: `request-${critic.id}`, criticId: critic.id, status: 'GREEN' })); }

test('Artifact prerequisites join every evaluator, independent of definition ordering', () => {
  const c = config(), graph = createGraphDefinition(c);
  assert.deepEqual(prerequisiteCriticIds(c.critics[0], graph), ['tests', 'spec-policy', 'spec-style', 'spec-second-opinion']);
  assert.deepEqual(prerequisiteCriticIds(c.critics[2], graph), []);
  const p = projectGraph(graph, requests(c));
  assert.equal(p.artifacts.find(a => a.id === 'spec')?.status, 'GREEN');
  assert.equal(p.artifacts.find(a => a.id === 'why')?.status, 'BASIS');
  assert.equal(p.artifacts.find(a => a.id === 'notes')?.status, 'UNREVIEWED');
  assert.deepEqual(p.edges.find(e => e.source === 'why' && e.target === 'spec')?.criticIds, ['spec-policy', 'spec-second-opinion']);
  assert.equal(p.edges.length, 4);
  assert.doesNotMatch(JSON.stringify(graph), /payload|instruction|humanTools/);
});

test('one successful selected Critic cannot make its Artifact GREEN or borrow other results', () => {
  const c = config(), graph = createGraphDefinition(c);
  const p = projectGraph(graph, [requests(c).find(r => r.criticId === 'spec-policy')!]);
  const spec = p.artifacts.find(a => a.id === 'spec')!;
  assert.deepEqual([spec.status, spec.passed, spec.total, spec.included], ['UNREVIEWED', 1, 3, 1]);
  assert.equal(p.critics.find(c => c.id === 'spec-style')?.requestId, null);
  assert.throws(() => projectGraph(graph, [requests(c)[0], requests(c)[0]]), /one Run/);
});

test('a failed parent does not convert blocked children into failed verdicts', () => {
  const c = config(), rs = requests(c);
  rs.find(r => r.criticId === 'spec-policy')!.status = 'RED';
  rs.find(r => r.criticId === 'tests')!.status = 'BLOCKED';
  rs.find(r => r.criticId === 'implementation')!.status = 'BLOCKED';
  const p = projectGraph(createGraphDefinition(c), rs);
  assert.equal(p.artifacts.find(a => a.id === 'spec')?.status, 'RED');
  assert.equal(p.artifacts.find(a => a.id === 'tests')?.status, 'BLOCKED');
  rs.find(r => r.criticId === 'spec-policy')!.status = 'ERROR';
  assert.equal(projectGraph(createGraphDefinition(c), rs).artifacts.find(a => a.id === 'spec')?.status, 'ERROR');
});

test('Human assignment and absent evaluations remain visible independently of verdicts', () => {
  const c = config(), rs = requests(c);
  const human = rs.find(r => r.criticId === 'spec-policy')!;
  human.status = 'WAITING_HUMAN'; human.claimedBy = 'reviewer';
  const p = projectGraph(createGraphDefinition(c), rs);
  assert.equal(p.artifacts.find(a => a.id === 'spec')?.status, 'WAITING_HUMAN');
  assert.equal(p.critics.find(c => c.id === human.criticId)?.claimedBy, 'reviewer');
});

test('invalid Artifact graphs fail before scheduling instead of waiting forever', () => {
  for (const mutate of [
    (c: RepoConfig) => { c.critics[1].deps = ['tests']; },
    (c: RepoConfig) => { c.critics[2].deps = ['implementation']; },
    (c: RepoConfig) => { c.critics[0].deps = ['missing']; },
    (c: RepoConfig) => { c.critics[0].deps = ['spec', 'spec']; },
    (c: RepoConfig) => { c.artifacts.why.basis = false; },
    (c: RepoConfig) => { c.artifacts.spec.basis = true; },
    (c: RepoConfig) => { c.critics[1].id = c.critics[0].id; },
  ]) { const c = config(); mutate(c); assert.throws(() => createGraphDefinition(c)); }
  assert.throws(() => validateGraphDefinition({ version: 1, artifacts: {}, critics: [] }));
});
