import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArtifactInstruction, digestArtifactInstruction } from '../src/artifacts/instruction.js';

const artifacts = [{ id: 'spec' }, { id: 'why' }, { id: 'ui-v2_test' }];

test('instruction references keep text order, whitespace, repeated IDs and exact Artifact identity', () => {
  assert.deepEqual(parseArtifactInstruction('{spec}이 {why}를 충족하는가?\n{spec}\t{ui-v2_test}', artifacts), [
    { type: 'artifact', artifactId: 'spec' }, { type: 'text', text: '이 ' },
    { type: 'artifact', artifactId: 'why' }, { type: 'text', text: '를 충족하는가?\n' },
    { type: 'artifact', artifactId: 'spec' }, { type: 'text', text: '\t' },
    { type: 'artifact', artifactId: 'ui-v2_test' },
  ]);
  assert.deepEqual(parseArtifactInstruction('', artifacts), []);
});

test('unknown, out-of-scope, ordinary JSON and expression-like braces remain byte-for-byte text', () => {
  for (const source of [
    'Read {implementation}, {specc}, {Spec} and { spec }.',
    '{"artifact":"spec","tools":["read_spec"],"example":"{spec}"}',
    '{"pattern":"} {spec}","escaped":"\\\""}',
    '{{spec}} {{{why}}} {outer: {spec}} {spec.path} {spec()} ${call()} ${spec}',
    String.raw`\{spec} \{why}`,
    'Missing brace {unfinished {spec}',
    '{' + 'x'.repeat(65) + '}',
  ]) {
    assert.deepEqual(parseArtifactInstruction(source, artifacts), [{ type: 'text', text: source }]);
    assert.equal(digestArtifactInstruction(source, artifacts, []), source);
  }
});

test('literal brace groups do not hide later independent references or rescan rendered JSON', () => {
  const instruction = String.raw`{{spec}} \{why} {"name":"{spec}"} then {spec}`;
  const digest = digestArtifactInstruction(instruction, artifacts, [{ artifactId: 'spec', name: 'inspect_spec' }]);
  assert.equal(digest, String.raw`{{spec}} \{why} {"name":"{spec}"} then {"artifact":"spec","tools":["inspect_spec"]}`);
  assert.equal(digestArtifactInstruction(digest, artifacts, []), digest);
  assert.equal(digestArtifactInstruction(String.raw`Keep \{spec\} and \{{spec}\} literally, then {why}.`, artifacts, [{ artifactId: 'why', name: 'read_why' }]),
    String.raw`Keep \{spec\} and \{{spec}\} literally, then {"artifact":"why","tools":["read_why"]}.`);
});

test('digest uses actual Artifact tool bindings, excludes unrelated tools and keeps no-tool references explicit', () => {
  const tools = [
    { artifactId: 'spec', name: 'read_spec' },
    { artifactId: 'why', name: 'read_why' },
    { artifactId: 'spec', name: 'grep_spec' },
    { artifactId: 'other', name: 'pretend_spec' },
    { artifactId: 'spec', name: 'grep_spec' },
  ];
  assert.equal(digestArtifactInstruction('{spec} vs {why}; {ui-v2_test}', artifacts, tools),
    '{"artifact":"spec","tools":["read_spec","grep_spec"]} vs {"artifact":"why","tools":["read_why"]}; {"artifact":"ui-v2_test","tools":[]}');
  assert.equal(digestArtifactInstruction('{spec}', artifacts, [{ artifactId: 'spec', name: 'open_spec' }]), '{"artifact":"spec","tools":["open_spec"]}');
});

test('identifiers with shared suffixes never borrow each other’s tools', () => {
  assert.equal(digestArtifactInstruction('{spec} {read_spec}', [{ id: 'spec' }, { id: 'read_spec' }], [
    { artifactId: 'spec', name: 'read_spec' }, { artifactId: 'read_spec', name: 'read_read_spec' },
  ]), '{"artifact":"spec","tools":["read_spec"]} {"artifact":"read_spec","tools":["read_read_spec"]}');
});
