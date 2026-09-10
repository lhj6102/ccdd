import assert from 'node:assert/strict';
import { compareVersions, tagCommit, validateAssets } from './release.mjs';
import { planNpmRelease, publishNpmRelease } from './npm-release.mjs';

export async function planNpmAnnouncement({ metadata, sourceCommit, api }) {
  assert.match(sourceCommit, /^[a-f0-9]{40}(?![\s\S])/, 'Source commit must be an exact commit SHA');
  compareVersions(metadata.version, metadata.version);
  assert.equal(metadata.tag, `v${metadata.version}`);
  assert.ok(api, 'An authenticated GitHub client is required for npm release announcements');
  const commit = await api.request('GET', `commits/${sourceCommit}`);
  assert.equal(commit.sha, sourceCommit, 'Push the requested commit to origin before publishing');
  const tagged = await tagCommit(api, metadata.tag);
  assert.ok(!tagged || tagged === sourceCommit, `${metadata.tag} already points to a different commit; tags are never moved.`);
  const release = await api.optional(`releases/tags/${metadata.tag}`);
  assert.ok(!release || tagged === sourceCommit, 'Existing Release must have the requested source tag');
  if (release) {
    const assets = await api.request('GET', `releases/${release.id}/assets?per_page=1`);
    assert.equal(assets.length, 0, 'Existing Release has download assets; migrate it explicitly before publishing an npm announcement');
  }
  return { tagged, release };
}

export function npmAnnouncementBody({ metadata, sourceCommit, repository }) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?![\s\S])/);
  assert.ok(repository.split('/').every(part => part !== '.' && part !== '..'));
  const source = `https://github.com/${repository}/blob/${sourceCommit}`;
  return [
    `CCDD ${metadata.tag} is available from npm. Install the matching package versions:`, '',
    '```sh',
    `npm install --ignore-scripts @ccdd/core@${metadata.version} @ccdd/project@${metadata.version} @ccdd/default-tools@${metadata.version}`,
    '```', '',
    'Node.js 24 or later is required. Install only core and Project if you use custom tools exclusively.', '',
    ...['@ccdd/core', '@ccdd/project', '@ccdd/default-tools'].map(name => `- [${name}@${metadata.version}](https://www.npmjs.com/package/${name}/v/${metadata.version})`), '',
    `[Release notes](${source}/docs/releases/${metadata.tag}.md) · [Getting started](${source}/docs/getting-started.md)`, '',
    `Source commit: [${sourceCommit}](https://github.com/${repository}/commit/${sourceCommit}).`, '',
    "Package downloads are distributed through npm. GitHub's automatic Source code archives contain source, not installable packages.", '',
  ].join('\n');
}

export async function publishNpmAnnouncement({ assetsDir, metadata, sourceCommit, repository, client, api }) {
  const files = await validateAssets(assetsDir, metadata, sourceCommit);
  const packages = await planNpmRelease({ files, metadata, client });
  assert.ok(packages.every(pkg => pkg.alreadyPublished), 'All three matching npm packages must be published before announcing the release');
  const body = npmAnnouncementBody({ metadata, sourceCommit, repository });
  const state = await planNpmAnnouncement({ metadata, sourceCommit, api });
  if (!state.tagged) {
    try { await api.request('POST', 'git/refs', { ref: `refs/tags/${metadata.tag}`, sha: sourceCommit }); }
    catch (error) { if (error.status !== 422 || await tagCommit(api, metadata.tag) !== sourceCommit) throw error; }
  }
  assert.equal(await tagCommit(api, metadata.tag), sourceCommit, 'Release tag changed; refusing to announce');
  // Retrying an older release must not displace a newer Latest announcement.
  const latest = await api.optional('releases/latest');
  const latestVersion = /^v(\d+\.\d+\.\d+)$/.exec(latest?.tag_name ?? '')?.[1];
  const makeLatest = !latestVersion || compareVersions(metadata.version, latestVersion) >= 0;
  const fields = { tag_name: metadata.tag, target_commitish: sourceCommit, name: `CCDD ${metadata.tag} — Install from npm`, body, draft: false, prerelease: false, make_latest: String(makeLatest) };
  const unchanged = state.release && ['name', 'body', 'draft', 'prerelease'].every(key => state.release[key] === fields[key]);
  if (unchanged && (!makeLatest || latest?.id === state.release.id)) return { status: 'ALREADY_ANNOUNCED', url: state.release.html_url };
  const release = state.release
    ? await api.request('PATCH', `releases/${state.release.id}`, fields)
    : await api.request('POST', 'releases', fields);
  assert.equal(await tagCommit(api, metadata.tag), sourceCommit, 'Release tag changed during announcement');
  return { status: 'ANNOUNCED', url: release.html_url };
}

export async function publishNpmAndAnnounce(options) {
  if (!options.dryRun) await planNpmAnnouncement(options);
  const result = options.announceOnly ? { status: 'ALREADY_PUBLISHED', published: false }
    : await publishNpmRelease(options);
  if (options.dryRun) return result;
  try { return { ...result, announcement: await publishNpmAnnouncement(options) }; }
  catch (error) {
    throw new Error(`${error.message}\nRetry only the GitHub announcement with npm run release:npm -- --commit ${options.sourceCommit} --announce-only --assets-dir ${JSON.stringify(options.assetsDir)}`);
  }
}
