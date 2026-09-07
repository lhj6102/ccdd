import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const coreName = '@lhj6102/ccdd';
const toolsName = '@lhj6102/ccdd-default-tools';
const projectName = '@lhj6102/ccdd-project';
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/;
const commitPattern = /^[0-9a-f]{40}(?![\s\S])/;
const hashPattern = /^[0-9a-f]{64}(?![\s\S])/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?![\s\S])/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const invariant = (condition, message) => { if (!condition) throw new Error(message); };
const jsonFile = async file => JSON.parse(await readFile(file, 'utf8'));

export function compareVersions(left, right) {
  invariant(stable.test(left) && stable.test(right), 'Release versions must be stable major.minor.patch values.');
  const a = left.split('.').map(BigInt), b = right.split('.').map(BigInt);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export function validateVersions(core, tools, lock) {
  invariant(core.name === coreName && tools.name === toolsName, 'Unexpected release package names.');
  invariant(typeof core.version === 'string' && stable.test(core.version), 'Release version must be stable major.minor.patch.');
  invariant(core.version === tools.version, 'Core and default tools versions must match.');
  const peer = tools.peerDependencies?.[coreName];
  // Both packages are released together. Keep the declared compatibility policy explicit.
  const range = typeof peer === 'string' && /^>=(\d+\.\d+\.\d+) <(0|[1-9]\d*)(?![\s\S])/.exec(peer);
  invariant(range && compareVersions(core.version, range[1]) >= 0 && BigInt(core.version.split('.')[0]) < BigInt(range[2]), 'Default tools peer range must include this core version (>=major.minor.patch <major).');
  invariant(lock.name === coreName && lock.version === core.version && lock.packages?.['']?.name === coreName && lock.packages[''].version === core.version, 'Root package-lock version is stale.');
  const entry = lock.packages?.['packages/default-tools'];
  invariant(entry?.version === tools.version && entry.peerDependencies?.[coreName] === peer, 'Default tools package-lock version or peer range is stale.');
  return core.version;
}

export async function readReleaseMetadata(root) {
  const [core, tools, lock] = await Promise.all([
    jsonFile(resolve(root, 'package.json')), jsonFile(resolve(root, 'packages/default-tools/package.json')), jsonFile(resolve(root, 'package-lock.json')),
  ]);
  const version = validateVersions(core, tools, lock), tag = `v${version}`;
  // Historical two-package releases remain verifiable; current workspaces must include Project.
  const project = await jsonFile(resolve(root, 'packages/project/package.json')).catch(error => { if (error.code === 'ENOENT' && !core.workspaces?.includes('packages/project')) return null; throw error; });
  if (project) {
    invariant(project.name === projectName && project.version === version, 'Project package name or version differs from core.');
    const peer = project.peerDependencies?.[coreName], range = typeof peer === 'string' && /^>=(\d+\.\d+\.\d+) <(0|[1-9]\d*)$/.exec(peer);
    invariant(range && compareVersions(version, range[1]) >= 0 && BigInt(version.split('.')[0]) < BigInt(range[2]), 'Project peer range must include this core version.');
    invariant(lock.packages?.['packages/project']?.version === version && lock.packages['packages/project'].peerDependencies?.[coreName] === peer, 'Project package-lock version or peer range is stale.');
  }
  const notes = await readFile(resolve(root, `docs/releases/${tag}.md`), 'utf8');
  invariant(notes.trim(), `Release notes docs/releases/${tag}.md must not be empty.`);
  return { version, tag, notes, coreFile: `lhj6102-ccdd-${version}.tgz`, toolsFile: `lhj6102-ccdd-default-tools-${version}.tgz`, ...(project ? { projectFile: `lhj6102-ccdd-project-${version}.tgz` } : {}) };
}

function validateRepository(repository) {
  invariant(typeof repository === 'string' && repositoryPattern.test(repository) && repository.split('/').every(part => part !== '.' && part !== '..'), 'Repository must identify owner/repository without path traversal.');
  return repository;
}

function context({ root, repository, sourceCommit, head }) {
  invariant(typeof sourceCommit === 'string' && commitPattern.test(sourceCommit), 'Source commit must be an exact commit SHA.');
  validateRepository(repository);
  const actualHead = head ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  invariant(actualHead === sourceCommit, 'Release checkout must match sourceCommit exactly.');
  return { sha: sourceCommit };
}

export function createGitHubClient({ repository, token, apiUrl = 'https://api.github.com', signal } = {}, fetchImpl = fetch) {
  invariant(typeof token === 'string' && token.length > 0 && !/\s/.test(token), 'An authenticated GitHub token is required for release operations.');
  validateRepository(repository);
  const base = new URL(apiUrl.replace(/\/?$/, '/'));
  invariant(base.protocol === 'https:' && !base.username && !base.password, 'GitHub API must use HTTPS without URL credentials.');
  const repo = repository.split('/').map(encodeURIComponent).join('/');
  async function request(method, path, body, { binary = false, upload = false } = {}) {
    signal?.throwIfAborted();
    const url = upload ? new URL(path) : new URL(`repos/${repo}/${path}`, base);
    if (upload) invariant(url.protocol === 'https:' && url.hostname === (base.hostname === 'api.github.com' ? 'uploads.github.com' : base.hostname), 'Unexpected GitHub upload host.');
    const headers = { Authorization: `Bearer ${token}`, Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (body !== undefined) headers['Content-Type'] = upload ? 'application/octet-stream' : 'application/json';
    let response;
    const timeoutSignal = AbortSignal.timeout(60_000);
    try { response = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : upload ? body : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal }); }
    catch { signal?.throwIfAborted(); throw new Error(`GitHub ${method} request failed before receiving a response.`); }
    if (!response.ok) {
      const error = new Error(`GitHub ${method} request failed (HTTP ${response.status}).`);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  }
  return {
    request,
    async optional(path) { try { return await request('GET', path); } catch (error) { if (error.status === 404) return null; throw error; } },
    async upload(release, name, bytes) {
      const url = new URL(release.upload_url.replace(/\{.*$/, ''));
      url.searchParams.set('name', name);
      return request('POST', url.href, bytes, { upload: true });
    },
    download: id => request('GET', `releases/assets/${id}`, undefined, { binary: true }),
  };
}

async function tagCommit(api, tag) {
  const ref = await api.optional(`git/ref/tags/${encodeURIComponent(tag)}`);
  if (!ref) return null;
  let object = ref.object;
  for (let depth = 0; object?.type === 'tag' && depth < 8; depth++) object = (await api.request('GET', `git/tags/${object.sha}`)).object;
  invariant(object?.type === 'commit' && commitPattern.test(object.sha), 'Release tag does not resolve to a commit.');
  return object.sha;
}

async function releaseState(api, metadata, sha) {
  const release = await api.optional(`releases/tags/${encodeURIComponent(metadata.tag)}`);
  if (release && !release.draft) return { published: true, release };
  const tagged = await tagCommit(api, metadata.tag);
  invariant(!tagged || tagged === sha, `${metadata.tag} already points to a different commit; tags are never moved.`);
  invariant(!release || release.target_commitish === sha, `${metadata.tag} draft belongs to a different commit.`);
  return { published: false, release, tagged };
}

export async function planRelease({ root = process.cwd(), repository, sourceCommit, api, head } = {}) {
  const ctx = context({ root, repository, sourceCommit, head }), metadata = await readReleaseMetadata(root);
  invariant(api, 'An authenticated GitHub client is required to plan the release.');
  const state = await releaseState(api, metadata, ctx.sha);
  return { version: metadata.version, tag: metadata.tag, should_build: !state.published, should_publish: !state.published, already_published: state.published, ...(state.published ? { url: state.release.html_url } : {}) };
}

// Read the packed manifest without extracting or executing archive contents.
function packedManifest(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 });
  let manifest;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/, '');
    const prefix = field(345, 500), name = `${prefix ? `${prefix}/` : ''}${field(0, 100)}`;
    const rawSize = field(124, 136).trim();
    invariant(/^[0-7]+$/.test(rawSize), 'Invalid release tar archive size.');
    const size = Number.parseInt(rawSize, 8), start = offset + 512;
    invariant(Number.isSafeInteger(size) && size >= 0 && start + size <= tar.length, 'Truncated release tar archive.');
    if (name === 'package/package.json') {
      invariant(manifest === undefined && (header[156] === 0 || header[156] === 48) && size < 1024 * 1024, 'Invalid packed package manifest.');
      manifest = JSON.parse(tar.subarray(start, start + size).toString('utf8'));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  invariant(manifest, 'Release tarball has no package/package.json.');
  return manifest;
}

export async function validateAssets(directory, metadata, sha) {
  const packages = [[coreName, metadata.coreFile], [toolsName, metadata.toolsFile], ...(metadata.projectFile ? [[projectName, metadata.projectFile]] : [])];
  const names = [...packages.map(([, file]) => file), 'verification.json', 'SHA256SUMS'].sort();
  invariant(JSON.stringify((await readdir(directory)).sort()) === JSON.stringify(names), 'Release assets must contain exactly the declared package tarballs, verification.json and SHA256SUMS.');
  const files = new Map();
  for (const name of names) {
    const file = resolve(directory, name), stat = await lstat(file);
    invariant(stat.isFile() && stat.size > 0 && stat.size <= 64 * 1024 * 1024, `Invalid release asset: ${name}.`);
    files.set(name, await readFile(file));
  }
  const sums = new Map();
  for (const line of files.get('SHA256SUMS').toString('utf8').trim().split('\n')) {
    const found = /^([0-9a-f]{64})  ([A-Za-z0-9_.-]+)$/.exec(line);
    invariant(found && !sums.has(found[2]), 'Invalid or duplicate SHA256SUMS entry.');
    sums.set(found[2], found[1]);
  }
  invariant(sums.size === packages.length + 1 && [...packages.map(([, file]) => file), 'verification.json'].every(name => sums.get(name) === sha256(files.get(name))), 'Release asset SHA-256 verification failed.');
  const report = JSON.parse(files.get('verification.json').toString('utf8'));
  invariant(report.schemaVersion === 1 && report.status === 'PASS' && report.version === metadata.version && report.tag === metadata.tag && report.sourceCommit === sha, 'Verification report does not match the tested commit and version.');
  const tests = report.tests;
  invariant(tests && Number.isSafeInteger(tests.total) && tests.total > 0 && tests.passed === tests.total && tests.failed === 0 && tests.cancelled === 0 && tests.skipped === 0 && tests.todo === 0 && hashPattern.test(tests.reportSha256), 'Verification report must prove a complete passing test run.');
  invariant(report.providerCalls === false && report.desktopLaunches === false, 'Release verification must not call Providers or launch desktop applications.');
  invariant(Array.isArray(report.installations) && report.installations.length === 2, 'Verification report must prove both production installation modes.');
  for (const [name, defaults, tool] of [['core-and-default-tools', true, 'read_spec'], ['core-only-custom-tool', false, 'inspect_spec']]) {
    const run = report.installations.find(item => item.name === name);
    invariant(run?.productionInstall === true && run.installScripts === false && run.cliHelpVersion === metadata.version && run.defaultToolsInstalled === defaults && run.tool === tool && run.actualToolExecution === true && run.workspaceMode === 'copy' && (!defaults || run.runtime === 'GREEN'), `Verification report is missing the ${name} installation check.`);
    if (metadata.projectFile) invariant(run.projectValidation === true, 'Project package must prove actual validation and reuse in both installation modes.');
  }
  invariant(Array.isArray(report.packages) && report.packages.length === packages.length, 'Verification report must identify all declared packages.');
  for (const [name, file] of packages) {
    const bytes = files.get(file), record = report.packages.find(item => item.name === name), manifest = packedManifest(bytes);
    invariant(record?.file === file && record.version === metadata.version && record.sha256 === sha256(bytes) && record.bytes === bytes.length && manifest.name === name && manifest.version === metadata.version, `Packed ${name} does not match the verification report.`);
  }
  return files;
}

async function assertDraft(api, id, metadata, sha) {
  const release = await api.request('GET', `releases/${id}`);
  invariant(release.draft && release.tag_name === metadata.tag && release.target_commitish === sha, 'Release is no longer the expected draft; refusing to change assets.');
  invariant(await tagCommit(api, metadata.tag) === sha, 'Release tag changed; refusing to publish.');
  return release;
}

export async function publishRelease({ root = process.cwd(), repository, sourceCommit, assetsDir, api, head } = {}) {
  const ctx = context({ root, repository, sourceCommit, head }), metadata = await readReleaseMetadata(root);
  invariant(api, 'An authenticated GitHub client is required to publish the release.');
  let state = await releaseState(api, metadata, ctx.sha);
  if (state.published) return { tag: metadata.tag, published: false, already_published: true, url: state.release.html_url };
  invariant(assetsDir, '--assets-dir is required.');
  const files = await validateAssets(resolve(assetsDir), metadata, ctx.sha);
  if (!state.tagged) {
    try { await api.request('POST', 'git/refs', { ref: `refs/tags/${metadata.tag}`, sha: ctx.sha }); }
    catch (error) { if (error.status !== 422 || await tagCommit(api, metadata.tag) !== ctx.sha) throw error; }
  }
  // Re-read after tag creation to handle an earlier interrupted or concurrent attempt.
  state = await releaseState(api, metadata, ctx.sha);
  if (state.published) return { tag: metadata.tag, published: false, already_published: true, url: state.release.html_url };
  let release = state.release;
  if (!release) release = await api.request('POST', 'releases', { tag_name: metadata.tag, target_commitish: ctx.sha, name: `CCDD ${metadata.tag}`, body: metadata.notes, draft: true, prerelease: false });
  release = await assertDraft(api, release.id, metadata, ctx.sha);
  const existing = await api.request('GET', `releases/${release.id}/assets?per_page=100`);
  invariant(existing.every(asset => files.has(asset.name)), 'Draft contains unexpected assets; refusing to publish it.');
  for (const [name, bytes] of files) {
    const matches = existing.filter(asset => asset.name === name);
    invariant(matches.length <= 1, 'Draft contains duplicate assets.');
    if (matches.length) {
      const asset = matches[0];
      if (sha256(await api.download(asset.id)) === sha256(bytes)) continue;
      await assertDraft(api, release.id, metadata, ctx.sha);
      await api.request('DELETE', `releases/assets/${asset.id}`);
    }
    await assertDraft(api, release.id, metadata, ctx.sha);
    await api.upload(release, name, bytes);
  }
  const uploaded = await api.request('GET', `releases/${release.id}/assets?per_page=100`);
  invariant(uploaded.length === files.size && new Set(uploaded.map(asset => asset.name)).size === files.size, 'Uploaded release assets are incomplete or duplicated.');
  for (const asset of uploaded) invariant(files.has(asset.name) && sha256(await api.download(asset.id)) === sha256(files.get(asset.name)), 'Remote release asset SHA-256 verification failed.');
  await assertDraft(api, release.id, metadata, ctx.sha);
  // GitHub chooses Latest using release history and semantic versions, not this retry's date.
  const published = await api.request('PATCH', `releases/${release.id}`, { draft: false, make_latest: 'legacy' });
  invariant(published.draft === false, 'GitHub did not publish the verified release.');
  return { tag: metadata.tag, published: true, already_published: false, url: published.html_url };
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.error('Use npm run release -- --commit SHA (optionally --dry-run).');
  process.exitCode = 1;
}
