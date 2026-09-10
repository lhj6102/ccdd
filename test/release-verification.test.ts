import test from 'node:test';
import assert from 'node:assert/strict';
const scriptUrl = new URL('../../scripts/verify-release.mjs', import.meta.url);
const { parseArguments, readTestSummary, packageFileAllowed } = await import(scriptUrl.href);

test('release verification requires matching stable version, tag, full commit and test report', () => {
  const args = ['--version', '1.0.0', '--tag', 'v1.0.0', '--source-commit', 'a'.repeat(40), '--output-dir', '/tmp/release', '--test-report', '/tmp/tests.tap'];
  assert.equal(parseArguments(args)['--version'], '1.0.0');
  for (const changed of [args.slice(0, -2), [...args, '--tag', 'v1.0.0'], args.map(value => value === 'v1.0.0' ? 'v0.9.0' : value), args.map(value => value === 'a'.repeat(40) ? 'main' : value), args.map(value => value === '1.0.0' ? '1.0.0-beta.1' : value)]) {
    assert.throws(() => parseArguments(changed));
  }
});

const passingTap = 'TAP version 13\nok 1 - release smoke\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1.5\n';

test('release verification rejects failed, unfinished, truncated and inconsistent TAP reports', () => {
  assert.deepEqual(readTestSummary(passingTap), { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  for (const invalid of [
    passingTap.replace('# fail 0', '# fail 1'),
    passingTap.replace('# cancelled 0', '# cancelled 1'),
    passingTap.replace('# skipped 0', '# skipped 1'),
    passingTap.replace('# todo 0', '# todo 1'),
    passingTap.replace('# pass 1', '# pass 0'),
    passingTap.replace('# tests 1', '# tests 2'),
    passingTap.replace('# pass 1\n', ''),
    passingTap + '# fail 0\n',
    passingTap.replace('ok 1', 'not ok 1'),
    passingTap + 'Bail out! stopped\n',
  ]) assert.throws(() => readTestSummary(invalid));
});

test('release archives separate pure definitions from runtime and reject state and credentials', () => {
  const core = '@ccdd/core', defaults = '@ccdd/default-tools', project = '@ccdd/project';
  for (const path of ['package.json', 'dist/src/sdk.d.ts', 'dist/src/definitions.js', 'dist/src/tools/contracts.d.ts', 'README.md', 'examples/custom-text-reader/ccdd.config.ts']) assert.equal(packageFileAllowed(core, path), true, path);
  for (const path of ['dist/src/executors/auth.js', 'dist/scripts/prepare-demo.js.map', 'dist/monitor-ui/index.html', 'dist/monitor-ui/assets/index-hash.css', 'docs/contracts.md', 'src/executors/CONTEXT.md']) { assert.equal(packageFileAllowed(project, path), true, path); assert.equal(packageFileAllowed(core, path), false, path); }
  for (const path of ['output/run.json', 'dist/src/auth.json', 'docs/credentials.json', 'dist/src/state/run.js', 'examples/.env', 'node_modules/pkg/index.js', '../package.json', '/package.json', 'dist\\src\\cli.js', 'docs/run.sqlite', 'dist/test/tool.test.js', 'src/cli.ts', 'snapshot/review.md', 'examples/default.tgz']) assert.equal(packageFileAllowed(core, path), false, path);
  for (const path of ['package.json', 'README.md', 'dist/index.js', 'dist/index.d.ts', 'dist/cli.js.map']) assert.equal(packageFileAllowed(defaults, path), true, path);
  assert.equal(packageFileAllowed(defaults, 'examples/config.ts'), false);
  assert.equal(packageFileAllowed(core, 'examples/artifact-groups/preview.png'), true);
  assert.equal(packageFileAllowed('unknown', 'dist/index.js'), false);
});
