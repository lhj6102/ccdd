import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactFixture, fixtureViews, agentProfile } from './helpers/artifacts.js';
import { diagnoseArtifactTools } from '../src/artifacts/tool-check.js';

test('tool preflight uses static registration, while explicit execution selects the canonical Artifact tool', async t => {
  const data = await artifactFixture(t); await data.write('a', { name: 'a', views: fixtureViews() });
  const before = await readFile(join(data.repoPath, 'a/ccdd.json'));
  const preflight = await diagnoseArtifactTools(data); assert.equal(preflight.ok, true); assert.deepEqual(preflight.tools.map(tool => tool.name), ['read_a', 'read_a']); assert.equal(preflight.result, undefined);
  const run = await diagnoseArtifactTools({ ...data, artifactId: 'a', audience: 'agent', toolName: 'read', execute: true, arguments: { lineCount: 1 } });
  assert.equal(run.ok, true, JSON.stringify(run)); assert.equal(run.result?.observation?.kind, 'content');
  assert.deepEqual(await readFile(join(data.repoPath, 'a/ccdd.json')), before);
  await assert.rejects(readFile(join(data.stateDir, 'broker.sqlite')), { code: 'ENOENT' });
});

test('execution requires explicit selection and empty audiences never gain default tools', async t => {
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [{ id: 'review', title: 'Review', profile: agentProfile, payload: { instruction: 'Read {a}.' } }] });
  assert.equal((await diagnoseArtifactTools(data)).ok, false);
  assert.equal((await diagnoseArtifactTools({ ...data, execute: true })).ok, false);
  assert.equal((await diagnoseArtifactTools({ ...data, artifactId: 'a', audience: 'agent', toolName: 'unknown' })).checks.some(c => c.code === 'ARTIFACT_TOOL_NOT_REGISTERED'), true);
});

test('a selected parent tool is diagnosed independently of admitted child and mount tools', async t => {
  const data = await artifactFixture(t);
  await data.write('parent', { name: 'parent', views: fixtureViews(), mounts: { reference: 'reference' } });
  await data.write('parent/child', { name: 'child', basis: true });
  await data.write('reference', { name: 'reference', basis: true, views: fixtureViews() });
  const selected = await diagnoseArtifactTools({ ...data, artifactId: 'parent', audience: 'agent', toolName: 'read', execute: true });
  assert.equal(selected.ok, true, JSON.stringify(selected.checks));
  assert.deepEqual(selected.tools.map(tool => tool.name), ['read_parent']);
  assert.equal(selected.result?.observation?.kind, 'content');
  const allViews = await diagnoseArtifactTools({ ...data, artifactId: 'parent', audience: 'agent' });
  assert.equal(allViews.ok, true, JSON.stringify(allViews.checks));
  assert.deepEqual(allViews.tools.map(tool => tool.name), ['read_parent', 'read_reference']);
});

test('arbitrary script errors are masked without suppressing the failure stage', async t => {
  const data = await artifactFixture(t); await data.write('a', { name: 'a', views: fixtureViews() }, { 'view.mjs': "throw new Error('SECRET_CREDENTIAL');" });
  const report = await diagnoseArtifactTools({ ...data, artifactId: 'a', audience: 'human', toolName: 'read', execute: true });
  assert.equal(report.ok, false); assert.equal(report.checks.at(-1)!.stage, 'execute'); assert.doesNotMatch(JSON.stringify(report), /SECRET_CREDENTIAL/);
});
