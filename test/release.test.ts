import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The release driver intentionally stays executable before npm ci / TypeScript build.
const driverUrl = new URL('../../scripts/release.mjs', import.meta.url);
const { validateVersions, compareVersions, planRelease, publishRelease, createGitHubClient, validateAssets } = await import(driverUrl.href);
const sha = 'a'.repeat(40), otherSha = 'b'.repeat(40), coreName = '@lhj6102/ccdd', toolsName = '@lhj6102/ccdd-default-tools';
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const metadata = { version: '1.0.0', tag: 'v1.0.0', coreFile: 'lhj6102-ccdd-1.0.0.tgz', toolsFile: 'lhj6102-ccdd-default-tools-1.0.0.tgz' };
const repository = 'lhj6102/ccdd';

function versions(version = '1.0.0') {
  const core = { name: coreName, version }, tools = { name: toolsName, version, peerDependencies: { [coreName]: '>=1.0.0 <2' } };
  return { core, tools, lock: { name: coreName, version, packages: { '': { ...core }, 'packages/default-tools': { ...tools } } } };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ccdd-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'packages/default-tools'), { recursive: true });
  await mkdir(join(root, 'docs/releases'), { recursive: true });
  const files = versions();
  await writeFile(join(root, 'package.json'), JSON.stringify(files.core));
  await writeFile(join(root, 'packages/default-tools/package.json'), JSON.stringify(files.tools));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify(files.lock));
  await writeFile(join(root, 'docs/releases/v1.0.0.md'), '# 1.0.0\nRelease notes.\n');
  return { root, repository, sourceCommit: sha, head: sha };
}

function tarball(name: string, version = '1.0.0') {
  const contents = Buffer.from(JSON.stringify({ name, version })), header = Buffer.alloc(512);
  header.write('package/package.json');
  header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(`${contents.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136); header.fill(' ', 148, 156); header[156] = 48;
  header.write('ustar\0', 257); header.write('00', 263);
  header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
  return gzipSync(Buffer.concat([header, contents, Buffer.alloc((512 - contents.length % 512) % 512 + 1024)]));
}

async function assets(root: string, reportOverrides: Record<string, unknown> = {}) {
  const assetsDir = join(root, 'assets'); await mkdir(assetsDir, { recursive: true });
  const packages = [[coreName, metadata.coreFile], [toolsName, metadata.toolsFile], ...(typeof reportOverrides.projectFile === 'string' ? [['@lhj6102/ccdd-project', reportOverrides.projectFile]] : [])].map(([name, file]) => {
    const bytes = tarball(name); return { name, version: '1.0.0', file, sha256: hash(bytes), bytes: bytes.length, content: bytes };
  });
  for (const item of packages) await writeFile(join(assetsDir, item.file), item.content);
  const installations = [
    { name: 'core-and-default-tools', productionInstall: true, installScripts: false, cliHelpVersion: '1.0.0', defaultToolsInstalled: true, tool: 'read_spec', actualToolExecution: true, workspaceMode: 'copy', runtime: 'GREEN', projectValidation: true },
    { name: 'core-only-custom-tool', productionInstall: true, installScripts: false, cliHelpVersion: '1.0.0', defaultToolsInstalled: false, tool: 'inspect_spec', actualToolExecution: true, workspaceMode: 'copy', projectValidation: true },
  ];
  const report = { schemaVersion: 1, status: 'PASS', ...metadata, sourceCommit: sha, tests: { total: 2, passed: 2, failed: 0, skipped: 0, cancelled: 0, todo: 0, reportSha256: 'c'.repeat(64) }, packages: packages.map(({ content, ...item }) => item), installations, providerCalls: false, desktopLaunches: false, ...reportOverrides };
  const reportText = JSON.stringify(report); await writeFile(join(assetsDir, 'verification.json'), reportText);
  await writeFile(join(assetsDir, 'SHA256SUMS'), [...packages.map(item => `${item.sha256}  ${item.file}`), `${hash(reportText)}  verification.json`].join('\n') + '\n');
  return assetsDir;
}

interface Draft { id: number; draft: boolean; tag_name: string; target_commitish: string; html_url: string; upload_url: string }

test('split-package releases require the Project tarball and its installed validation proof', async t => {
  const f = await fixture(t), projectFile = 'lhj6102-ccdd-project-1.0.0.tgz';
  const directory = await assets(f.root, { projectFile });
  const files = await validateAssets(directory, { ...metadata, projectFile }, sha);
  assert.equal(files.size, 5); assert.ok(files.has(projectFile));
  await assert.rejects(validateAssets(directory, metadata, sha), /exactly/);
});
interface Asset { id: number; name: string; bytes: Buffer }
function fakeApi(options: { published?: boolean; draft?: boolean; target?: string; tagged?: string; annotated?: boolean; failUpload?: boolean; corruptDownload?: boolean } = {}) {
  let nextAsset = 1;
  const api = {
    events: [] as string[],
    tag: options.tagged ?? null,
    release: options.published || options.draft ? { id: 1, draft: !options.published, tag_name: 'v1.0.0', target_commitish: options.target ?? sha, html_url: 'https://github.com/lhj6102/ccdd/releases/tag/v1.0.0', upload_url: 'https://uploads.github.com/fixture{?name}' } as Draft : null,
    assets: [] as Asset[],
    failUpload: options.failUpload ?? false,
    corruptDownload: options.corruptDownload ?? false,
    async optional(path: string): Promise<unknown> {
      api.events.push(`GET ${path}`);
      if (path.startsWith('releases/tags/')) return api.release;
      if (path.startsWith('git/ref/tags/')) return api.tag ? { object: { type: options.annotated ? 'tag' : 'commit', sha: api.tag } } : null;
      throw new Error(`Unexpected GET ${path}`);
    },
    async request(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
      api.events.push(`${method} ${path}`);
      if (method === 'GET' && path.startsWith('git/tags/')) return { object: { type: 'commit', sha: api.tag } };
      if (method === 'POST' && path === 'git/refs') { assert.equal(body?.sha, sha); api.tag = String(body?.sha); return {}; }
      if (method === 'POST' && path === 'releases') { api.release = { ...body, id: 1, html_url: 'release-url', upload_url: 'upload-url' } as Draft; return api.release; }
      if (method === 'GET' && path === 'releases/1') return api.release;
      if (method === 'GET' && path.startsWith('releases/1/assets')) return api.assets.map(({ bytes, ...item }) => item);
      if (method === 'DELETE' && path.startsWith('releases/assets/')) { assert.equal(api.release?.draft, true); api.assets = api.assets.filter(item => item.id !== Number(path.split('/').at(-1))); return null; }
      if (method === 'PATCH' && path === 'releases/1') { assert.equal(body?.make_latest, 'legacy'); assert.equal(api.release?.draft, true); api.release!.draft = false; return api.release; }
      throw new Error(`Unexpected ${method} ${path}`);
    },
    async upload(_release: Draft, name: string, bytes: Buffer) {
      api.events.push(`UPLOAD ${name}`);
      assert.equal(api.release?.draft, true);
      if (api.failUpload && api.assets.length === 1) { api.failUpload = false; throw new Error('Simulated interrupted upload'); }
      const asset = { id: nextAsset++, name, bytes }; api.assets.push(asset); return asset;
    },
    async download(id: number) { api.events.push(`DOWNLOAD ${id}`); return api.corruptDownload ? Buffer.from('corrupted remote data') : api.assets.find(item => item.id === id)!.bytes; },
  };
  return api;
}

test('release versions require aligned packages, lock entries, stable semver and a compatible peer range', () => {
  const current = versions(); assert.equal(validateVersions(current.core, current.tools, current.lock), '1.0.0');
  for (const mutate of [
    (v: ReturnType<typeof versions>) => { v.tools.version = '0.9.0'; },
    (v: ReturnType<typeof versions>) => { v.lock.version = '0.9.0'; },
    (v: ReturnType<typeof versions>) => { v.lock.packages['packages/default-tools'].version = '0.9.0'; },
    (v: ReturnType<typeof versions>) => { v.tools.peerDependencies[coreName] = '>=0.9.0 <1'; },
    (v: ReturnType<typeof versions>) => { v.core.name = 'different-package'; },
  ]) { const data = versions(); mutate(data); assert.throws(() => validateVersions(data.core, data.tools, data.lock)); }
  for (const version of ['1.0.0-rc.1', '1.0', '01.0.0', '1.0.0\n', 'v1.0.0']) { const data = versions(version); assert.throws(() => validateVersions(data.core, data.tools, data.lock)); }
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
});

test('local plans use explicit repository and commit inputs and only read remote release state', async t => {
  const data = await fixture(t), api = fakeApi();
  assert.deepEqual(await planRelease({ ...data, api }), { version: '1.0.0', tag: 'v1.0.0', should_build: true, should_publish: true, already_published: false });
  assert.ok(api.events.every(event => event.startsWith('GET ')), 'Planning never creates tags, releases or assets.');
  for (const sourceCommit of [undefined, 'main', 'abcdef0', `${sha}\n`, otherSha]) await assert.rejects(planRelease({ ...data, api, sourceCommit }), /exact commit|checkout/);
  for (const invalidRepository of [undefined, '', '../repo', 'owner/..', 'owner/repo/extra', `${repository}\n`]) await assert.rejects(planRelease({ ...data, api, repository: invalidRepository }), /owner\/repository/);
  await assert.rejects(planRelease({ ...data }), /authenticated GitHub client/);
  await assert.rejects(planRelease({ ...data, api, head: otherSha }), /checkout/);
  await rm(join(data.root, 'docs/releases/v1.0.0.md'));
  await assert.rejects(planRelease({ ...data, api }), { code: 'ENOENT' });
});

test('published versions skip later commits without rebuilding or changing any assets', async t => {
  const data = await fixture(t), api = fakeApi({ published: true, tagged: otherSha, target: otherSha });
  const plan = await planRelease({ ...data, api }); assert.equal(plan.should_build, false); assert.equal(plan.should_publish, false);
  const published = await publishRelease({ ...data, api }); assert.equal(published.already_published, true);
  assert.ok(api.events.every(event => event.startsWith('GET ')));
});

test('existing lightweight or annotated tags and draft targets cannot be redirected', async t => {
  const data = await fixture(t);
  for (const options of [{ tagged: otherSha }, { tagged: otherSha, annotated: true }, { draft: true, target: otherSha }]) {
    const api = fakeApi(options); await assert.rejects(planRelease({ ...data, api }), /different commit/);
    await assert.rejects(publishRelease({ ...data, api }), /different commit/);
    assert.ok(api.events.every(event => event.startsWith('GET ')));
  }
  assert.equal((await planRelease({ ...data, api: fakeApi({ tagged: sha, annotated: true }) })).should_publish, true);
});

test('publisher rejects failed tests, wrong commit, invalid checksums and mismatched packed identities before tag creation', async t => {
  const data = await fixture(t);
  for (const overrides of [{ sourceCommit: otherSha }, { version: '1.0.1' }, { tests: { total: 2, passed: 1, failed: 1 } }, { installations: [] }, { providerCalls: true }]) {
    const assetsDir = await assets(data.root, overrides), api = fakeApi();
    await assert.rejects(publishRelease({ ...data, assetsDir, api }), /Verification|Release verification/);
    assert.ok(api.events.every(event => event.startsWith('GET ')));
  }
  const assetsDir = await assets(data.root), api = fakeApi();
  await writeFile(join(assetsDir, metadata.coreFile), tarball('wrong-name'));
  await assert.rejects(publishRelease({ ...data, assetsDir, api }), /SHA-256/);
  await assets(data.root); await writeFile(join(assetsDir, 'unexpected.txt'), 'not a release asset');
  await assert.rejects(validateAssets(assetsDir, metadata, sha), /exactly/);
  await assert.rejects(publishRelease({ ...data, assetsDir, api, head: otherSha }), /checkout/);
  await assert.rejects(publishRelease({ ...data, assetsDir, api, sourceCommit: 'main' }), /exact commit/);
  await assert.rejects(publishRelease({ ...data, assetsDir, api, repository: '../repo' }), /owner\/repository/);
  await assert.rejects(publishRelease({ ...data, assetsDir }), /authenticated GitHub client/);
});

test('interrupted uploads leave a draft and retry verifies every remote asset before publishing', async t => {
  const data = await fixture(t), assetsDir = await assets(data.root), api = fakeApi({ failUpload: true });
  await assert.rejects(publishRelease({ ...data, assetsDir, api }), /interrupted upload/);
  assert.equal(api.release?.draft, true); assert.equal(api.tag, sha); assert.equal(api.assets.length, 1);
  assert.equal(api.events.some(event => event.startsWith('PATCH')), false);
  const result = await publishRelease({ ...data, assetsDir, api });
  assert.equal(result.published, true); assert.equal(api.release?.draft, false); assert.equal(api.assets.length, 4);
  assert.equal(api.events.filter(event => event === 'POST git/refs').length, 1);
  assert.equal(api.events.filter(event => event.startsWith('UPLOAD')).length, 5, 'Retry reuses the completed identical upload.');
  assert.ok(api.events.indexOf('PATCH releases/1') > api.events.findLastIndex(event => event.startsWith('DOWNLOAD')));
  const before = api.events.length; await publishRelease({ ...data, assetsDir, api });
  assert.ok(api.events.slice(before).every(event => event.startsWith('GET ')), 'Published release retry performs no mutations.');
});

test('a retry may replace changed draft validation evidence but never publishes corrupt remote downloads', async t => {
  const data = await fixture(t), assetsDir = await assets(data.root), api = fakeApi({ failUpload: true });
  await assert.rejects(publishRelease({ ...data, assetsDir, api }));
  api.assets[0].bytes = Buffer.from('incomplete previous attempt');
  await publishRelease({ ...data, assetsDir, api });
  assert.ok(api.events.some(event => event.startsWith('DELETE releases/assets/')));
  const corrupt = fakeApi({ corruptDownload: true });
  await assert.rejects(publishRelease({ ...data, assetsDir, api: corrupt }), /Remote.*SHA-256/);
  assert.equal(corrupt.release?.draft, true); assert.equal(corrupt.events.some(event => event.startsWith('PATCH')), false);
});

test('API errors only treat 404 as missing and never expose response secrets or send tokens to an unexpected upload host', async () => {
  const auth = { repository, token: 'test-token-not-for-logs' };
  for (const token of ['', 'token\n', undefined]) assert.throws(() => createGitHubClient({ ...auth, token }), /authenticated GitHub token/);
  assert.throws(() => createGitHubClient({ ...auth, repository: '../repo' }), /owner\/repository/);
  const missing = createGitHubClient(auth, async () => new Response('missing', { status: 404 }));
  assert.equal(await missing.optional('releases/tags/v1.0.0'), null);
  const denied = createGitHubClient(auth, async () => new Response('sensitive server detail', { status: 403 }));
  await assert.rejects(denied.optional('releases/tags/v1.0.0'), (error: Error) => /HTTP 403/.test(error.message) && !/sensitive|test-token/.test(error.message));
  await assert.rejects(denied.upload({ upload_url: 'https://unrelated.example/upload{?name}' }, 'a.tgz', Buffer.from('asset')), /upload host/);
  let called = '';
  const enterprise = createGitHubClient({ ...auth, apiUrl: 'https://github.example/api/v3' }, async (url: URL) => { called = url.href; return Response.json({}); });
  await enterprise.request('GET', 'releases/tags/v1.0.0');
  assert.equal(called, 'https://github.example/api/v3/repos/lhj6102/ccdd/releases/tags/v1.0.0');
});

test('cancellation prevents new API mutations and aborts an in-flight request', async () => {
  const reason = new Error('Release cancelled');
  let calls = 0;
  const alreadyCancelled = createGitHubClient({ repository, token: 'test-token', signal: AbortSignal.abort(reason) }, async () => { calls++; return Response.json({}); });
  await assert.rejects(alreadyCancelled.request('POST', 'git/refs', { sha }), error => error === reason);
  assert.equal(calls, 0, 'A cancelled release must not start another mutation.');
  const controller = new AbortController();
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const inFlight = createGitHubClient({ repository, token: 'test-token', signal: controller.signal }, async (_url: URL, options: { signal: AbortSignal }) => {
    started();
    return new Promise<Response>((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); });
  });
  const response = inFlight.request('GET', 'releases/tags/v1.0.0');
  const rejected = assert.rejects(response, error => error === reason);
  await waiting; controller.abort(reason); await rejected;
});

test('cancellation after tag creation leaves recoverable state and never starts release publication', async t => {
  const data = await fixture(t), assetsDir = await assets(data.root), controller = new AbortController();
  const calls: string[] = [], reason = new Error('Release cancelled after tag creation');
  const api = createGitHubClient({ repository, token: 'test-token', signal: controller.signal }, async (url: URL, options: { method: string }) => {
    const path = url.pathname.replace('/repos/lhj6102/ccdd/', '');
    calls.push(`${options.method} ${path}`);
    if (options.method === 'GET') return new Response('not found', { status: 404 });
    assert.equal(`${options.method} ${path}`, 'POST git/refs');
    controller.abort(reason);
    return Response.json({ ref: 'refs/tags/v1.0.0', object: { type: 'commit', sha } });
  });
  await assert.rejects(publishRelease({ ...data, assetsDir, api }), error => error === reason);
  assert.deepEqual(calls.filter(call => !call.startsWith('GET ')), ['POST git/refs']);
});
