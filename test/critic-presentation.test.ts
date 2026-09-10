import test from 'node:test';
import assert from 'node:assert/strict';
import type { GraphCriticState } from '../src/broker/graph.js';
import type { MonitorRequest } from '../src/monitor/types.js';
import { criticPresentation } from '../src/monitor/ui/critic-presentation.js';

const critic: GraphCriticState = { id: 'human-check', title: 'Review documents', target: 'spec', deps: ['why'], kind: 'human', requestId: 'request-one', status: 'WAITING_HUMAN', claimedBy: null, blockedReason: null };
const request = (values: Partial<MonitorRequest>): MonitorRequest => ({ id: 'request-one', criticId: 'human-check', kind: 'human', status: 'WAITING_HUMAN', claimedBy: null, blockedByFailure: false, ...values } as MonitorRequest);

test('Human icon stays requested until claim and then shows a running review', () => {
  assert.equal(criticPresentation(critic).tone, 'requested');
  assert.equal(criticPresentation(critic, request({ claimedBy: 'reviewer' })).tone, 'running');
  assert.equal(criticPresentation({ ...critic, claimedBy: 'reviewer' }).tone, 'running');
  assert.match(criticPresentation(critic).accessibleLabel, /Review documents.*Human.*Awaiting reviewer/);
  assert.equal(criticPresentation(critic, request({ id: 'unrelated', claimedBy: 'reviewer' })).tone, 'requested');
});

test('omitted Critic is never actionable or shown as queued, even alongside a successful review', () => {
  const state = criticPresentation({ ...critic, requestId: null, status: null }, request({ status: 'GREEN' }));
  assert.equal(state.actionable, false); assert.equal(state.tone, 'omitted'); assert.equal(state.mark, 'omitted');
  assert.match(state.label, /Not included/);
  assert.equal(criticPresentation({ ...critic, status: 'GREEN' }).tone, 'success');
});

test('upstream failure does not misrepresent the blocked Critic as a failed evaluation', () => {
  const state = criticPresentation({ ...critic, status: 'BLOCKED' }, request({ status: 'BLOCKED', blockedByFailure: true }));
  assert.equal(state.tone, 'requested'); assert.equal(state.mark, 'blocked'); assert.match(state.label, /Blocked.*Dependency failed/);
  assert.equal(criticPresentation({ ...critic, status: 'BLOCKED' }).mark, 'waiting');
  assert.equal(criticPresentation({ ...critic, status: 'BLOCKED', blockedReason: 'Waiting for spec-review to become GREEN.' }).mark, 'waiting');
});

test('evaluation failure and execution error share the failure color but keep distinct meaning', () => {
  const red = criticPresentation({ ...critic, status: 'RED' }), error = criticPresentation({ ...critic, status: 'ERROR' });
  assert.equal(red.tone, 'failure'); assert.equal(error.tone, 'failure');
  assert.notEqual(red.mark, error.mark); assert.match(red.label, /Failed/); assert.match(error.label, /Execution error/);
});

test('pull states distinguish needed validation and actual reused evidence from queued tickets', () => {
  const needed = criticPresentation({ ...critic, requestId: null, status: null, validationStatus: 'STALE' });
  assert.equal(needed.actionable, false); assert.equal(needed.label, 'Needs revalidation');
  const blocked = criticPresentation({ ...critic, status: 'BLOCKED', validationStatus: 'BLOCKED' });
  assert.equal(blocked.label, 'Dependencies need validation'); assert.equal(blocked.actionable, true, 'earlier actual evidence remains inspectable');
  const reused = criticPresentation({ ...critic, status: 'GREEN', validationStatus: 'PASS', reusedFrom: { requestId: 'request-one', runId: 'earlier', completedAt: '2026-01-01T00:00:00.000Z' } });
  assert.match(reused.label, /Previous verdict reused/); assert.equal(reused.actionable, true);
});
