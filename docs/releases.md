# Releases and npm installation

CCDD packages are distributed through npm. GitHub Releases announce each version with an installation command, npm package links, and release notes. They do not host installation tarballs. GitHub still supplies automatic Source code archives; those contain source, not installable packages.

See [getting started](getting-started.md) for setup and [v3.1.2 release notes](releases/v3.1.2.md) for the current changes.

## Installing and upgrading

CCDD 3.1.2 supports Node.js 22 LTS (22.19.0 or later). Install matching versions of the three packages:

```sh
npm install --ignore-scripts @ccdd/core@3.1.2 @ccdd/project@3.1.2 @ccdd/default-tools@3.1.2
npx ccdd-project config check
npx ccdd-project tools check
```

`@ccdd/core` supplies definitions. `@ccdd/project` supplies validation, the CLI, Broker, Executors, and monitor. `@ccdd/default-tools` is optional when all tools are custom. Project and default-tools 3.x target core `>=3.0.0 <4`.

Active reviews retain their original snapshots, implementations, and actual evidence. Install the new version in the original project for subsequent requests and restart an active monitor with the new CLI. Review state and copies are not deleted or converted.

For older projects, follow the [package and import migration](releases/v2.0.1.md#migration), [Project migration from v1](releases/v2.0.0.md#migrating-from-v1), and, when needed, [configuration migration from before v1](releases/v1.0.0.md#migrating-existing-configuration). Use `npx ccdd doctor` in the Agent environment to check actual authentication, Provider, and model access. It calls the Provider and consumes account usage. `tools check --execute` actually runs the selected tool.

## Publishing a version

CI runs once on each push to main. Its single Node 22 LTS job builds and tests
the commit, verifies the packed production installations, and uploads
`release-<commit SHA>` containing the three tarballs and verification files.
PR creation and version tags do not trigger another test run.

To publish, merge the version change and release notes, wait for that commit's
CI to succeed, then push its version tag:

```sh
git tag v3.1.2 COMMIT_SHA
git push origin v3.1.2
```

`release.yml` runs one Node 22 LTS job. It installs npm 11.19.1 for Trusted
Publishing, downloads the successful main CI artifact for the exact tagged
commit, and publishes those bytes through `scripts/publish-ci.mjs`. It does not
install project dependencies, build, or run tests. Commit/version/checksum and
registry-integrity checks prevent publishing a different artifact; these are
publication checks, not another test suite.

The tag must match the package version. npm authenticates through GitHub Actions
OIDC and the package's registered Trusted Publisher. CI artifacts are retained
for 14 days. An early tag or missing artifact stops CD; wait for CI or rerun CI
for that commit, then rerun Release. Retrying Release reuses the same artifact
and skips identical packages already published to npm.

### Trusted Publisher setup

Register the following GitHub Actions publisher on each of `@ccdd/core`,
`@ccdd/project`, and `@ccdd/default-tools`:

- Repository: `lhj6102/ccdd`
- Workflow filename: `release.yml`
- Permission: direct publication with `npm publish`

With npm 11.15.0 or later and package owner access:

```sh
npm trust github @ccdd/core --repository=lhj6102/ccdd --file=release.yml --allow-publish --yes
npm trust github @ccdd/project --repository=lhj6102/ccdd --file=release.yml --allow-publish --yes
npm trust github @ccdd/default-tools --repository=lhj6102/ccdd --file=release.yml --allow-publish --yes
```

npm requires account two-factor authentication for registration. The release
workflow uses OIDC; it does not require an npm token stored in GitHub secrets.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Local verification and publication

The independent local release command remains available when publishing without GitHub Actions. It verifies an exact committed snapshot. You need Git, Node.js 22 LTS (22.19.0 or later), npm, dependency download access or a populated cache, an npm account with publication rights in the `@ccdd` organization, and a GitHub CLI (`gh`) login with write access to the origin repository.

CCDD 3.1.0 adds Node 22 LTS support and the MIT license. Older packages retain their original requirements. Run release verification locally with Node 22 LTS, selected by `.nvmrc`.

Keep all three package versions and their lockfile entries aligned. Commit `docs/releases/v<version>.md` with the release notes and push the requested commit to origin. Published npm versions cannot be replaced; use a new coordinated version for changed package contents.

```sh
nvm use # With nvm, select Node 22 LTS from .nvmrc.
npm run release:npm:check
gh auth status

# Replace COMMIT_SHA with the exact 40-character commit SHA.
npm run release:npm -- --commit COMMIT_SHA --dry-run --output-dir /tmp/ccdd-npm-check

# Authenticate if needed, then publish the same commit.
npm login --registry=https://registry.npmjs.org/
gh auth login
npm run release:npm -- --commit COMMIT_SHA --output-dir /tmp/ccdd-npm-release
```

Use a new empty output directory outside the repository for each build. `--output-dir` is optional. The command reports where it retains the verified files and logs; keep the verified files until both npm publication and the GitHub announcement succeed.

`release:npm:check` uses read-only operations to check Node/npm versions, the logged-in account, email verification, 2FA settings, and the `ccdd` organization role. It does not print tokens or email addresses. An individual npm login does not automatically grant organization publication rights.

Local publication checks the GitHub source commit and tag, then the logged-in npm account and organization role before building. Build and test children receive isolated configuration without publisher or Provider credentials. The command clones the requested commit, installs locked dependencies, builds, runs the full test suite, packs all three packages, and verifies production installations and actual tool and Runtime behavior in separate projects. Uncommitted caller changes are excluded. No external LLM or desktop application is called by release verification.

Before writing to npm, every existing target package version must match the verified tarball's SHA-512 integrity. Matching versions are skipped; a mismatch stops publication. Packages publish in core → Project → default tools order with public access and the `latest` npm tag. Fresh public metadata confirms each published version; short registry propagation delays are retried.

**After all three exact package versions are confirmed, the same command creates or updates the matching GitHub Release.** Its tag points to the verified source commit and is never moved. The announcement includes the versioned npm install command, package links, and source-linked release notes. Its Node requirement comes from the verified Project tarball, so recovery of an older release retains that version's requirement. GitHub selects Latest on the server using its automatic version/date policy, so an older retry never explicitly overrides a newer announcement. Retrying an unchanged announcement performs no writes. Future versions keep their own announcement entries; historical tarball releases were removed once during the npm migration, preserving their Git tags and commit history.

This automation runs through `npm run release:npm` (equivalent to `npm run release -- --npm`). A manual `npm publish` outside this workflow does not update GitHub. GitHub notification behavior is documented in its [release API](https://docs.github.com/en/rest/releases/releases#create-a-release).

`--dry-run` performs build and package verification and `npm publish --dry-run`, with public metadata reads but no registry or GitHub writes and no login requirement. It does not guarantee account publication rights or successful 2FA. The legacy `npm run release -- --commit COMMIT_SHA --dry-run` remains available for local tarball verification alone; its former GitHub tarball publication path now stops with instructions to use npm.

## Recovering a partial publication

The three npm publications and the GitHub announcement are not one transaction. For GitHub Actions, rerun Release to reuse the verified CI artifact. For local publication, rerun the same commit with a new empty output directory. Identical versions already in npm are skipped. Never increment versions just to retry unchanged bytes.

If npm succeeded but the GitHub announcement failed, use the retained verified files and the original source commit:

```sh
npm run release:npm -- --commit COMMIT_SHA --announce-only --assets-dir /tmp/ccdd-npm-release
```

This command requires GitHub authentication but no npm login. It loads metadata from the exact committed snapshot, validates the retained checksums and verification record, and confirms all three matching npm versions before any GitHub write. It does not rebuild or publish npm packages. A missing or mismatched package, moved source tag, or existing Release with uploaded assets stops the operation. The command never silently deletes historical downloads.

## Local verification files

These files remain local release evidence and recovery inputs:

| File | Purpose |
| --- | --- |
| `ccdd-core-<version>.tgz` | Definition-only SDK package |
| `ccdd-project-<version>.tgz` | Project execution package |
| `ccdd-default-tools-<version>.tgz` | Optional default tool library |
| `verification.json` | Source commit, complete tests, and production installation evidence |
| `SHA256SUMS` | SHA-256 checksums of packages and verification record |

The [demo guide](demo.md) also supports these locally built tarballs. Preparing an existing demo again does not upgrade its packages; keep edited demos and use a new empty `--demo-dir`.

npm references: [publication and version immutability](https://docs.npmjs.com/cli/v11/commands/npm-publish/) and [public scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).
