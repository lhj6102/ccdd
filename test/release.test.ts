import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The release driver intentionally stays executable before npm ci / TypeScript build.
const driverUrl = new URL('../../scripts/release.mjs', import.meta.url);
const { compareVersions, createGitHubClient, validateAssets } = await import(driverUrl.href);
const { publishNpmRelease, createNpmClient } = await import(new URL('../../scripts/npm-release.mjs', import.meta.url).href);
const { publishNpmAndAnnounce, publishNpmAnnouncement } = await import(new URL('../../scripts/npm-announcement.mjs', import.meta.url).href);
const { publishFromCi } = await import(new URL('../../scripts/publish-ci.mjs', import.meta.url).href);
const sha = 'a'.repeat(40), otherSha = 'b'.repeat(40), coreName = '@ccdd/core', toolsName = '@ccdd/default-tools';
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const metadata = { version: '1.0.0', tag: 'v1.0.0', coreFile: 'ccdd-core-1.0.0.tgz', toolsFile: 'ccdd-default-tools-1.0.0.tgz' };
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

function tarball(name: string, version = '1.0.0', publishConfig?: Record<string, unknown>, nodeRange = '>=24') {
  const contents = Buffer.from(JSON.stringify({ name, version, publishConfig, engines: { node: nodeRange } })), header = Buffer.alloc(512);
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
  const packages = [[coreName, metadata.coreFile], [toolsName, metadata.toolsFile], ...(typeof reportOverrides.projectFile === 'string' ? [['@ccdd/project', reportOverrides.projectFile]] : [])].map(([name, file]) => {
    const bytes = tarball(name, '1.0.0', reportOverrides.publishConfig as Record<string, unknown> | undefined, reportOverrides.nodeRange as string | undefined); return { name, version: '1.0.0', file, sha256: hash(bytes), bytes: bytes.length, content: bytes };
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

async function npmFixture(t: TestContext, nodeRange = '>=24') {
  const data = await fixture(t), npmMetadata = { ...metadata, projectFile: 'ccdd-project-1.0.0.tgz' };
  const manifests = versions();
  const project = { name: '@ccdd/project', version: '1.0.0', peerDependencies: { [coreName]: '>=1.0.0 <2' } };
  await mkdir(join(data.root, 'packages/project'));
  await writeFile(join(data.root, 'packages/project/package.json'), JSON.stringify(project));
  await writeFile(join(data.root, 'package-lock.json'), JSON.stringify({ ...manifests.lock,
    packages: { ...manifests.lock.packages, 'packages/project': project } }));
  const assetsDir = await assets(data.root, { projectFile: npmMetadata.projectFile, publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' }, nodeRange });
  const files = await validateAssets(assetsDir, npmMetadata, sha);
  const events: string[] = [], published = new Map<string, unknown>();
  const client = {
    async version(name: string) { events.push(`GET ${name}`); return published.get(name) ?? null; },
    async publish(file: string, bytes: Buffer, { dryRun }: { dryRun: boolean }) {
      events.push(`${dryRun ? 'DRY_RUN' : 'PUBLISH'} ${file}`);
      assert.deepEqual(bytes, files.get(file), 'Publish the exact verified tarball');
      if (dryRun) return;
      const name = file === npmMetadata.coreFile ? coreName : file === npmMetadata.toolsFile ? toolsName : '@ccdd/project';
      published.set(name, { name, version: '1.0.0', dist: { integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } });
    },
  };
  return { ...data, assetsDir, metadata: npmMetadata, client, events, published };
}

test('npm release dry-run verifies all three packages without registry writes', async t => {
  const data = await npmFixture(t);
  const result = await publishNpmRelease({ ...data, dryRun: true });
  assert.equal(result.status, 'VERIFIED'); assert.equal(result.published, false); assert.equal(data.published.size, 0);
  assert.deepEqual(data.events.slice(0, 3), [`GET ${coreName}`, 'GET @ccdd/project', `GET ${toolsName}`]);
  assert.equal(data.events.filter(event => event.startsWith('DRY_RUN')).length, 3);
});

test('npm release resumes a partial publish using identical registry integrity and keeps core first', async t => {
  const data = await npmFixture(t), publish = data.client.publish;
  data.client.publish = async (...args) => {
    if (args[0] === data.metadata.projectFile) throw new Error('Interrupted publication');
    return publish(...args);
  };
  await assert.rejects(publishNpmRelease(data), /Interrupted/);
  assert.deepEqual([...data.published.keys()], [coreName]);
  data.client.publish = publish;
  assert.equal((await publishNpmRelease(data)).status, 'PUBLISHED');
  assert.deepEqual([...data.published.keys()], [coreName, '@ccdd/project', toolsName]);
  assert.equal(data.events.filter(event => event === `PUBLISH ${metadata.coreFile}`).length, 1);
  const before = data.events.length;
  assert.equal((await publishNpmRelease(data)).status, 'ALREADY_PUBLISHED');
  assert.ok(data.events.slice(before).every(event => event.startsWith('GET')));
});

test('npm release rejects conflicting remote bytes or bad local evidence before any publish', async t => {
  const data = await npmFixture(t);
  data.published.set(toolsName, { name: toolsName, version: '1.0.0', dist: { integrity: 'sha512-different' } });
  await assert.rejects(publishNpmRelease(data), /different bytes/);
  assert.ok(data.events.every(event => event.startsWith('GET')));
  data.published.clear(); data.events.length = 0;
  await writeFile(join(data.assetsDir, metadata.coreFile), 'tampered');
  await assert.rejects(publishNpmRelease(data), /SHA-256/);
  assert.deepEqual(data.events, []);
  for (const overrides of [{ sourceCommit: otherSha }, { tests: { total: 2, passed: 1, failed: 1 } }, { installations: [] }]) {
    await assets(data.root, { projectFile: data.metadata.projectFile, ...overrides });
    await assert.rejects(publishNpmRelease(data), /Verification|Release verification/);
    assert.deepEqual(data.events, []);
  }
});

test('npm release refuses archives without explicit public publishing configuration', async t => {
  const data = await npmFixture(t);
  await assets(data.root, { projectFile: data.metadata.projectFile });
  await assert.rejects(publishNpmRelease(data), /explicitly publish/);
  assert.deepEqual(data.events, []);
});

test('npm publication does not claim success when registry metadata is not yet available', async t => {
  const data = await npmFixture(t);
  data.client.version = async () => null;
  await assert.rejects(publishNpmRelease(data), /not confirmed.*Rerun the same commit/);
  assert.deepEqual([...data.published.keys()], [coreName], 'Stop before publishing dependent packages');
});

test('npm metadata errors and cancellation cannot masquerade as an unpublished version', async () => {
  for (const status of [401, 403, 429, 500]) {
    const client = createNpmClient({}, async () => new Response('sensitive response', { status }));
    await assert.rejects(client.version(coreName, '1.0.0'), new RegExp(`HTTP ${status}`));
  }
  const missing = createNpmClient({}, async (url: string, options: { headers?: unknown }) => {
    assert.match(url, /^https:\/\/registry.npmjs.org\/%40ccdd%2Fcore\?release_check=\d+$/);
    assert.deepEqual(options.headers, { 'Cache-Control': 'no-cache' });
    return new Response('', { status: 404 });
  });
  assert.equal(await missing.version(coreName, '1.0.0'), null);
  const cancelled = createNpmClient({ signal: AbortSignal.abort(new Error('Cancelled')) }, async () => assert.fail('Cancelled lookup must not fetch'));
  await assert.rejects(cancelled.version(coreName, '1.0.0'), /Cancelled/);
  await assert.rejects(cancelled.publish('unused.tgz', Buffer.from('unused'), { dryRun: true }), /Cancelled/);
});

test('npm confirmation reads full metadata and waits for a newly published version', async () => {
  let calls = 0;
  const version = { name: coreName, version: '1.0.0', dist: { integrity: 'sha512-fixture' } };
  const client = createNpmClient({}, async () => Response.json({ versions: ++calls === 1 ? {} : { '1.0.0': version } }));
  assert.deepEqual(await client.confirm(coreName, '1.0.0'), version);
  assert.equal(calls, 2);
  const controller = new AbortController();
  const cancelled = createNpmClient({ signal: controller.signal }, async () => {
    controller.abort(new Error('Stop waiting for npm'));
    return Response.json({ versions: {} });
  });
  await assert.rejects(cancelled.confirm(coreName, '1.0.0'), /abort/i);
});

function announcementApi() {
  const events: string[] = [];
  let tag: string | null = null;
  let release: Record<string, unknown> | null = null;
  let latest: Record<string, unknown> | null = null;
  const api = {
    events,
    failPublish: false,
    concurrentLatest: null as Record<string, unknown> | null,
    downloads: [] as unknown[],
    setTag(value: string) { tag = value; },
    setLatest(value: Record<string, unknown>) { latest = value; },
    getRelease() { return release; },
    getLatest() { return latest; },
    async optional(path: string): Promise<unknown> {
      events.push(`GET ${path}`);
      if (path === 'git/ref/tags/v1.0.0') return tag ? { object: { type: 'commit', sha: tag } } : null;
      if (path === 'releases/tags/v1.0.0') return release;
      if (path === 'releases/latest') return latest;
      assert.fail(`Unexpected GET ${path}`);
    },
    async request(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
      events.push(`${method} ${path}`);
      if (method === 'GET' && path === `commits/${sha}`) return { sha };
      if (method === 'GET' && path === 'releases/1/assets?per_page=1') return api.downloads;
      if (method === 'POST' && path === 'git/refs') { assert.equal(body?.sha, sha); tag = sha; return {}; }
      if (method === 'POST' && path === 'releases' || method === 'PATCH' && path === 'releases/1') {
        if (api.failPublish) throw new Error('GitHub unavailable');
        release = { id: 1, html_url: 'https://github.com/lhj6102/ccdd/releases/tag/v1.0.0', ...body };
        if (api.concurrentLatest) latest = api.concurrentLatest;
        if (body?.make_latest === 'legacy' && (!latest || compareVersions(String(latest.tag_name).slice(1), String(body.tag_name).slice(1)) <= 0)) latest = release;
        if (body?.make_latest === 'true') latest = release;
        return release;
      }
      assert.fail(`Unexpected ${method} ${path}`);
    },
  };
  return api;
}

test('successful npm publication automatically creates an npm announcement and retries without writes', async t => {
  const data = await npmFixture(t), api = announcementApi();
  const result = await publishNpmAndAnnounce({ ...data, api });
  assert.equal(result.announcement.status, 'ANNOUNCED');
  assert.equal(data.published.size, 3);
  const release = api.getRelease()!;
  assert.equal(release.target_commitish, sha);
  assert.equal(release.make_latest, 'legacy');
  assert.equal(release.draft, false);
  assert.match(String(release.body), /npm install --ignore-scripts @ccdd\/core@1\.0\.0 @ccdd\/project@1\.0\.0 @ccdd\/default-tools@1\.0\.0/);
  assert.match(String(release.body), new RegExp(`/blob/${sha}/docs/releases/v1.0.0.md`));
  assert.equal(api.events.some(event => event.includes('uploads') || event.startsWith('DELETE')), false);
  api.events.length = 0; data.events.length = 0;
  assert.equal((await publishNpmAndAnnounce({ ...data, api })).announcement.status, 'ALREADY_ANNOUNCED');
  assert.ok([...api.events, ...data.events].every(event => event.startsWith('GET')));
});

test('announcement recovery preserves the Node requirement of the verified package version', async t => {
  for (const [range, requirement] of [['>=24', 'Node.js 24 or later'], ['^22.19.0', 'Node.js 22 LTS (>=22.19.0)']]) {
    const data = await npmFixture(t, range), api = announcementApi();
    await publishNpmRelease(data);
    await publishNpmAndAnnounce({ ...data, api, announceOnly: true });
    assert.ok(String(api.getRelease()!.body).includes(`${requirement} is required.`));
  }
});

test('dry runs, partial npm publication and tag conflicts cannot create an announcement', async t => {
  const data = await npmFixture(t), api = announcementApi();
  await publishNpmAndAnnounce({ ...data, api, dryRun: true });
  assert.equal(api.events.length, 0);
  assert.equal(data.published.size, 0);
  await assert.rejects(publishNpmAndAnnounce({ ...data, api, announceOnly: true }), /All three matching/);
  assert.ok(api.events.every(event => event.startsWith('GET')));
  api.setTag(otherSha); data.events.length = 0;
  await assert.rejects(publishNpmAndAnnounce({ ...data, api }), /different commit/);
  assert.deepEqual(data.events, []);
  api.setTag(sha);
  const publish = data.client.publish;
  data.client.publish = async (...args) => {
    if (args[0] === data.metadata.projectFile) throw new Error('Interrupted npm');
    return publish(...args);
  };
  await assert.rejects(publishNpmAndAnnounce({ ...data, api }), /Interrupted npm/);
  assert.equal(data.published.size, 1);
  assert.ok(api.events.every(event => event.startsWith('GET')));
});

test('announcement-only recovery verifies retained bytes and never republishes npm packages', async t => {
  const data = await npmFixture(t), api = announcementApi();
  const directory = join(data.root, "assets $release `printf unused` 'quoted'");
  await rename(data.assetsDir, directory);
  data.assetsDir = directory;
  api.failPublish = true;
  await assert.rejects(publishNpmAndAnnounce({ ...data, api }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /GitHub unavailable.*\nRetry.*--announce-only --assets-dir/);
    assert.ok(error.message.endsWith("assets $release `printf unused` '\\''quoted'\\'''"));
    return true;
  });
  assert.equal(data.published.size, 3);
  data.events.length = 0; api.failPublish = false;
  await publishNpmAndAnnounce({ ...data, api, announceOnly: true });
  assert.ok(data.events.every(event => event.startsWith('GET')));
  data.published.set(toolsName, { name: toolsName, version: '1.0.0', dist: { integrity: 'sha512-conflict' } });
  api.events.length = 0;
  await assert.rejects(publishNpmAnnouncement({ ...data, api }), /different bytes/);
  assert.equal(api.events.length, 0);
  await writeFile(join(data.assetsDir, data.metadata.coreFile), 'tampered');
  await assert.rejects(publishNpmAnnouncement({ ...data, api }), /SHA-256/);
});

test('announcement updates preserve newer Latest releases and refuse to delete existing downloads', async t => {
  const data = await npmFixture(t), api = announcementApi();
  await publishNpmAndAnnounce({ ...data, api });
  api.getRelease()!.body = 'Stale installation instructions';
  api.setLatest({ id: 2, tag_name: 'v2.0.0' });
  await publishNpmAnnouncement({ ...data, api });
  assert.equal(api.getRelease()!.make_latest, 'legacy');
  assert.equal(api.getLatest()!.tag_name, 'v2.0.0');
  api.downloads.push({ id: 100, name: 'historical.tgz' });
  api.events.length = 0;
  await assert.rejects(publishNpmAnnouncement({ ...data, api }), /download assets/);
  assert.ok(api.events.every(event => event.startsWith('GET')));
  api.downloads.length = 0; api.setTag(otherSha);
  await assert.rejects(publishNpmAnnouncement({ ...data, api }), /different commit/);
});

test('an older announcement retry delegates Latest selection when a newer release publishes concurrently', async t => {
  const data = await npmFixture(t), api = announcementApi();
  await publishNpmAndAnnounce({ ...data, api });
  api.getRelease()!.body = 'Needs an announcement refresh';
  api.concurrentLatest = { id: 2, tag_name: 'v2.0.0' };
  await publishNpmAnnouncement({ ...data, api });
  assert.equal(api.getRelease()!.make_latest, 'legacy', 'GitHub must choose Latest on the server rather than receiving a stale forced update');
  assert.equal(api.getLatest()!.tag_name, 'v2.0.0');
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

test('CD publishes the exact successful main CI artifact and retries without rebuilding or republishing', async t => {
  const data = await npmFixture(t), api = announcementApi(), request = api.request;
  let downloads = 0;
  api.request = async (method: string, path: string, body?: Record<string, unknown>) => {
    if (path.startsWith('actions/workflows/ci.yml/runs?')) {
      assert.equal(method, 'GET');
      const query = new URLSearchParams(path.split('?')[1]);
      assert.equal(query.get('head_sha'), sha);
      assert.equal(query.get('branch'), 'main');
      assert.equal(query.get('event'), 'push');
      assert.equal(query.get('status'), 'success');
      return { workflow_runs: [{ id: 42, head_sha: sha, head_branch: 'main', event: 'push', conclusion: 'success' }] };
    }
    return request(method, path, body);
  };
  const options = { ...data, api, ref: 'refs/tags/v1.0.0',
    async download(id: number, name: string, directory: string) {
      assert.equal(id, 42); assert.equal(name, `release-${sha}`); assert.equal(directory, data.assetsDir);
      downloads++;
    } };
  assert.equal((await publishFromCi(options)).status, 'PUBLISHED');
  assert.equal(data.published.size, 3);
  data.events.length = 0;
  assert.equal((await publishFromCi(options)).status, 'ALREADY_PUBLISHED');
  assert.equal(downloads, 2);
  assert.ok(data.events.every(event => event.startsWith('GET')));
});

test('CD cannot download or publish without successful CI for the tagged main commit', async t => {
  const data = await npmFixture(t), api = announcementApi();
  const success = { id: 42, head_sha: sha, head_branch: 'main', event: 'push', conclusion: 'success' };
  const options = { ...data, api, ref: 'refs/tags/v1.0.0', download: async () => assert.fail('No artifact may be downloaded') };
  for (const runs of [[], [{ ...success, head_sha: otherSha }], [{ ...success, conclusion: 'failure' }],
    [{ ...success, event: 'pull_request' }], [{ ...success, head_branch: 'untrusted' }]]) {
    api.request = async () => ({ workflow_runs: runs });
    await assert.rejects(publishFromCi(options), /No successful main CI/);
  }
  await assert.rejects(publishFromCi({ ...options, ref: 'refs/tags/v9.0.0' }), /tag must match/);
  assert.deepEqual(data.events, []);
  assert.deepEqual(api.events, []);
});
