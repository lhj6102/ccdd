import test from 'node:test';
import assert from 'node:assert/strict';
import { initialToolFields, initialToolJson, parseToolFields, parseToolJson, toolInputForm } from '../src/monitor/ui/tool-input.js';
import { toolContent } from '../src/monitor/ui/tool-content.js';

test('Human fields preserve decimal, boolean, enum and literal string values without implicit coercion', () => {
  const schema = { type: 'object', properties: {
    time: { type: 'number', minimum: 0, maximum: 1 }, frame: { type: 'integer', minimum: 0 },
    loop: { type: 'boolean' }, mode: { enum: [1, '1', false, null] }, label: { type: 'string' },
  }, required: ['time', 'frame', 'loop', 'mode', 'label'], additionalProperties: false };
  const form = toolInputForm(schema);
  assert.equal(form.json, false);
  const values = { time: '0.125', frame: '0', loop: 'false', mode: '1', label: '  clip name  ' };
  assert.deepEqual(parseToolFields(schema, form.fields, values), { time: 0.125, frame: 0, loop: false, mode: '1', label: '  clip name  ' });
  assert.equal(parseToolFields(schema, form.fields, { ...values, mode: '0' }).mode, 1);
  assert.equal(parseToolFields(schema, form.fields, { ...values, mode: '2' }).mode, false);
  assert.equal(parseToolFields(schema, form.fields, { ...values, mode: '3' }).mode, null);
  for (const bad of [{ frame: '1.5' }, { time: '1.1' }, { time: 'Infinity' }, { time: '0x01' }, { time: '' }, { loop: '0' }, { mode: '9' }]) {
    assert.throws(() => parseToolFields(schema, form.fields, { ...values, ...bad }));
  }
});

test('Human JSON input validates nested objects, arrays and unions while preserving types', () => {
  const schema = { type: 'object', properties: {
    frames: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1 },
    camera: { type: 'object', properties: { enabled: { type: 'boolean' }, scale: { type: 'number' } }, required: ['enabled', 'scale'], additionalProperties: false },
    range: { oneOf: [{ type: 'string', enum: ['all'] }, { type: 'integer', minimum: 0 }] },
  }, required: ['frames', 'camera', 'range'], additionalProperties: false };
  assert.equal(toolInputForm(schema).json, true);
  const valid = { frames: [0, 2], camera: { enabled: false, scale: 0.25 }, range: 0 };
  assert.deepEqual(parseToolJson(schema, JSON.stringify(valid)), valid);
  for (const input of [[], null, { ...valid, frames: ['0'] }, { ...valid, camera: { enabled: 'false', scale: 0.25 } }, { ...valid, unregistered: true }, { ...valid, range: true }]) {
    assert.throws(() => parseToolJson(schema, JSON.stringify(input)));
  }
  assert.throws(() => parseToolJson(schema, '{broken'));
  assert.throws(() => parseToolJson({ type: 'object' }, JSON.stringify({ text: 'x'.repeat(33_000) })), /32KiB/);
});

test('Human forms use only explicit schema defaults for custom tools and retain optional omission', () => {
  const schema = { type: 'object', properties: {
    startLine: { type: 'integer' }, enabled: { type: 'boolean', default: false }, nothing: { enum: [null, 'value'], default: null },
  }, additionalProperties: false };
  const form = toolInputForm(schema);
  assert.deepEqual(initialToolFields(form.fields), { startLine: '', enabled: 'false', nothing: '0' });
  assert.deepEqual(parseToolFields(schema, form.fields, initialToolFields(form.fields)), { enabled: false, nothing: null });
  assert.equal(initialToolFields(form.fields, true).startLine, '1');
  assert.deepEqual(JSON.parse(initialToolJson(schema)), { enabled: false, nothing: null });
  assert.equal(toolInputForm({ type: 'object', additionalProperties: false }).json, false, 'Desktop open has no artificial required inputs');
  assert.equal(toolInputForm({ type: 'object' }).json, true, 'Free-form inputs must remain expressible');
});

test('generic tool results display content without treating text, arbitrary paths or vector images as executable content', () => {
  const markup = '<script>throw new Error("never HTML")</script>';
  assert.deepEqual(toolContent({ content: [
    { type: 'text', text: markup }, { type: 'json', data: { frames: [1, 2], enabled: false } },
    { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }, { type: 'launch', launched: true },
  ] }), [
    { type: 'text', text: markup }, { type: 'json', text: '{\n  "frames": [\n    1,\n    2\n  ],\n  "enabled": false\n}' },
    { type: 'image', src: 'data:image/png;base64,aW1hZ2U=' }, { type: 'launch' },
  ]);
  for (const image of [
    { path: '/etc/private.png', mimeType: 'image/png' }, { data: '<svg onload="alert(1)">', mimeType: 'image/svg+xml' },
    { data: 'https://example.com/image.png', mimeType: 'image/png' }, { data: 'a'.repeat(5_592_412), mimeType: 'image/png' },
  ]) assert.deepEqual(toolContent({ content: [{ type: 'image', ...image }] }), [{ type: 'unsupported' }]);
  assert.equal(toolContent({ content: 'legacy text', startLine: 1 }), null);
});
