import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalData, dataHash, MAX_ARTIFACT_DATA_BYTES, MAX_ARTIFACT_DATA_DEPTH } from '../src/artifacts/data.js';

test('equivalent structured Artifact data has deterministic canonical bytes and SHA-256 identity', () => {
  const first = { z: { second: true, first: null }, a: [1, -0, 'value'] };
  const second = { a: [1, 0, 'value'], z: { first: null, second: true } };
  assert.equal(canonicalData(first), '{"a":[1,0,"value"],"z":{"first":null,"second":true}}');
  assert.equal(canonicalData(first), canonicalData(second));
  assert.equal(dataHash(first), dataHash(second));
  assert.equal(dataHash({}), '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  assert.equal(dataHash(JSON.parse(canonicalData(first))), dataHash(first));
  assert.equal(canonicalData(Object.assign(Object.create(null), { z: 1, a: 2 })), '{"a":2,"z":1}');
});

test('all material participates in identity and array order is significant', () => {
  const data = { visible: { summary: 'same' }, details: { unrequested: ['first', 'second'] } };
  assert.notEqual(dataHash(data), dataHash({ ...data, details: { unrequested: ['first', 'changed'] } }));
  assert.notEqual(dataHash(data), dataHash({ ...data, details: { unrequested: ['second', 'first'] } }));
  assert.notEqual(dataHash({ value: null }), dataHash({}));
  assert.notEqual(dataHash({ value: 1 }), dataHash({ value: '1' }));
});

test('Unicode keys use UTF-16 order while Unicode values and JSON escaping retain their exact meaning', () => {
  const value = { '\ue000': '\u00e9', '\ud800\udc00': 'e\u0301', '\ud55c': '\ud55c\uae00\ud83d\ude42\r\n', '10': '\u0000', '2': '\ud800' };
  const expected = `{"10":"\\u0000","2":"\\ud800","\ud55c":"\ud55c\uae00\ud83d\ude42\\r\\n","\ud800\udc00":"e\u0301","\ue000":"\u00e9"}`;
  assert.equal(canonicalData(value), expected);
  assert.deepEqual(JSON.parse(canonicalData(value)), value);
  assert.notEqual(dataHash('\u00e9'), dataHash('e\u0301'));
  assert.equal(canonicalData({ '\\"': '\\"\b\f\t' }), '{"\\\\\\\"":"\\\\\\\"\\b\\f\\t"}');
});

test('unsupported values are rejected without JSON omission or invoking serialization hooks', () => {
  const invalid = [undefined, () => 1, Symbol('value'), 1n, NaN, Infinity, -Infinity, new Date(0), /value/, new Map(), new Set(), new Uint8Array([1]), new Number(1), Object.create({ inherited: true })];
  for (const value of invalid) {
    assert.throws(() => canonicalData(value), TypeError);
    assert.throws(() => canonicalData({ nested: value }), TypeError);
    assert.throws(() => canonicalData([value]), TypeError);
  }
  let calls = 0;
  assert.throws(() => canonicalData({ get value() { calls += 1; return 1; } }), /accessors/);
  assert.throws(() => canonicalData({ toJSON() { calls += 1; return 1; } }), /JSON values/);
  const array = [1];
  Object.defineProperty(array, '0', { get() { calls += 1; return 1; } });
  assert.throws(() => canonicalData(array), /accessors/);
  assert.equal(calls, 0);
});

test('sparse arrays and hidden or extra properties cannot be silently excluded from material', () => {
  for (const value of [new Array(1), [1, , 3], Object.assign([1], { extra: true }), Object.assign([1], { '01': true }), Object.assign({}, { [Symbol('hidden')]: true })]) {
    assert.throws(() => canonicalData(value), TypeError);
  }
  for (const value of [{}, [1]]) {
    Object.defineProperty(value, 'hidden', { value: true });
    assert.throws(() => canonicalData(value), TypeError);
  }
  const array = [1];
  Object.defineProperty(array, '0', { enumerable: false });
  assert.throws(() => canonicalData(array), /enumerable/);
});

test('cycles fail explicitly while repeated acyclic values can be materialized', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalData(cyclic), /cycles/);
  const array: unknown[] = [];
  array.push(array);
  assert.throws(() => canonicalData(array), /cycles/);
  const shared = { value: 1 };
  assert.equal(canonicalData([shared, shared]), '[{"value":1},{"value":1}]');
});

test('container depth has an explicit bound before the JavaScript stack limit', () => {
  let value: unknown = 1;
  for (let depth = 0; depth < MAX_ARTIFACT_DATA_DEPTH; depth += 1) value = [value];
  assert.equal(canonicalData(value), `${'['.repeat(MAX_ARTIFACT_DATA_DEPTH)}1${']'.repeat(MAX_ARTIFACT_DATA_DEPTH)}`);
  assert.throws(() => canonicalData([value]), /nested containers/);
});

test('the encoded byte limit includes UTF-8, escaping, keys and collection punctuation', () => {
  const exact = 'x'.repeat(MAX_ARTIFACT_DATA_BYTES - 2);
  assert.equal(Buffer.byteLength(canonicalData(exact), 'utf8'), MAX_ARTIFACT_DATA_BYTES);
  assert.throws(() => canonicalData(`${exact}x`), /byte canonical JSON limit/);
  assert.throws(() => canonicalData('x'.repeat(MAX_ARTIFACT_DATA_BYTES + 1)), /byte canonical JSON limit/);
  assert.throws(() => canonicalData('\ud55c'.repeat(Math.floor(MAX_ARTIFACT_DATA_BYTES / 3))), /byte canonical JSON limit/);
  assert.throws(() => canonicalData('\u0000'.repeat(Math.floor(MAX_ARTIFACT_DATA_BYTES / 6) + 1)), /byte canonical JSON limit/);
  assert.throws(() => canonicalData({ [exact]: 0 }), /byte canonical JSON limit/);
  assert.throws(() => canonicalData([exact]), /byte canonical JSON limit/);
});
