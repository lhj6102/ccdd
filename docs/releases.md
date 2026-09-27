# Releases and npm installation

CCDD packages are distributed through npm. GitHub Releases announce each version with an installation command, npm package links, and release notes. They do not host installation tarballs. GitHub still supplies automatic Source code archives; those contain source, not installable packages.

See [getting started](getting-started.md) for setup and [v6.2.0 release notes](releases/v6.2.0.md) for current changes.

## Current release: 6.2.0

This release adds only the single-install `@ccdd/ccdd` facade and unchanged Pi AI
public API forwards. The facade uses normal exact dependencies on core, Project,
default-tools and Pi AI. There is no new authentication CLI, persistence backend,
provider registry or credential policy. Pi remains 0.87.1; format-6 state and
review semantics are unchanged. See [installation choices](getting-started.md#installation-choices).

## Upgrading to 6.1

1. Finish or cancel reviews with their old installation and **stop all 6.0 workers**.
   New code cannot make an already-running old executable obey machine admission.
2. Install matching core, Project and any default-tools packages at 6.1.0. Project
   and default-tools require core `>=6.1.0 <7`; mixed 6.0 core is unsupported.
   Core now declares identity weights, root review policy and pinned script
   execution-path context. Default-tools follows the aligned support policy;
   this is not a claim that every older individual tool call necessarily fails.
3. Remove `identityConcurrency` / `--identity-concurrency`. Set local
   `identityCapacity` and per-Artifact `stale.weight` instead. Optional executor
   concurrency is an additional tighter cap, never an independent provider pool.
4. Keep one shared local resource configuration and machine state root across
   processes/repositories. Use per-repository `--state-dir` for review history;
   do not give each repository a different `CCDD_STATE_HOME`. Restart with the
   new CLI and `resources-1` workers; old saved worker files cannot resume.
5. Preserve format-6 completed evidence. There is no migration, forced semantic
   identity salt or new state-directory requirement for 6.0 completed history.
   Missing historical execution provenance is `null`, never filled from current
   files. Preserve the machine database while Runs refer to its durable budgets.

Declared runtime tools must use pinned entrypoints, relative captured siblings,
or `context.executionPaths`; the runtime cache is not an OS sandbox. See the
[full upgrade and resource contract](review-management.md#repository-policy-and-migration).

## Breaking changes when upgrading from before 6.0

**Use a fresh external state directory.** State format 6 rejects all prior
formats, including 5.x, with no migration or compatibility reads. Keep old audit
state with its matching old installation; do not change its format marker.

Dependency-GREEN gates now apply by default. Handle `BLOCKED`, `WAIT_DEPENDENCY`
and `counts.gated`; use `ignoreGates` / `--ignore-gates` only when ungated
execution is intended. Same-input operational ERROR can be requeued through
`retryRequest` after the worker settles; changed input needs a new submission.

Live subscribers should drain `broker.changes` cursors. Compact `getRun` and
`listRuns` are explicit whole-Run snapshots, not per-event polling APIs.
Normalized content-addressed storage authenticates immutable records and keeps
large definitions off lifecycle transitions. The optional admission hook is
cancellable; in 6.1 it adds a precondition to the mandatory shared machine
admission rather than replacing it.
See the [6.0 migration guide](migration-v6.md) and release notes for the measured
performance, integrity guarantees and stated limits.

## Installing and upgrading

CCDD 6.2.0 supports Node.js 22 LTS (22.19.0 or later). The default is one public installation package:

```sh
npm install --ignore-scripts @ccdd/ccdd
# or: pnpm add --ignore-scripts @ccdd/ccdd
npx ccdd-project config check
npx ccdd-project tools check
```

`@ccdd/ccdd` installs the three exact matching modules and exposes their public subpaths and CLI bins. Advanced module-only consumers may omit the umbrella. `@ccdd/core` supplies definitions. `@ccdd/project` supplies validation, the CLI, Broker, Executors, and monitor. `@ccdd/default-tools` is optional when all tools are custom. Project and default-tools 6.2.0 target core `>=6.1.0 <7`. Keep installed CCDD packages on the same major line.

Version 4 introduced folder-owned `ccdd.json` files. Projects older than v4
must also follow the [v4 configuration migration](migration-v4.md). The
[5.0 response-contract migration](migration-v5.md) remains relevant for callers
upgrading from 4.x; all upgrades to 6.0 must follow the [6.0 migration](migration-v6.md).

Finish or cancel active reviews before changing dependencies in the reviewed
workspace. Restart workers and the monitor with the new CLI. Use a fresh state
directory only when upgrading from a pre-6.0 format; existing format-6 state is
compatible with 6.2.0. Older state is not automatically deleted and is not readable
or resumable by 6.0; inspect it only with its corresponding old installation.

For older projects, follow the [package and import migration](releases/v2.0.1.md#migration), [Project migration from v1](releases/v2.0.0.md#migrating-from-v1), and, when needed, [configuration migration from before v1](releases/v1.0.0.md#migrating-existing-configuration). Use `npx ccdd doctor` in the Agent environment to check actual authentication, Provider, and model access. It calls the Provider and consumes account usage. `tools check --execute` actually runs the selected tool.

## Publishing a version

CI runs once on each push to main. Its single Node 22 LTS job builds and tests
the commit, verifies the packed production installations, and uploads
`release-<commit SHA>` containing the four tarballs and verification files.
PR creation and version tags do not trigger another test run.

To publish, merge the version change and release notes, wait for that commit's
CI to succeed, then push its version tag:

```sh
git tag v6.2.0 COMMIT_SHA
git push origin v6.2.0
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
`@ccdd/project`, `@ccdd/default-tools`, and `@ccdd/ccdd`:

- Repository: `lhj6102/ccdd`
- Workflow filename: `release.yml`
- Permission: direct publication with `npm publish`

With npm 11.15.0 or later and package owner access:

```sh
npm trust github @ccdd/core --repository=lhj6102/ccdd --file=release.yml --allow-publish --yes
npm trust github @ccdd/project --repository=lhj6102/ccdd --file=release.yml --allow-publish --yes
npm trust github @ccdd/default-tools --repository=lhj6102/ccdd --file=release.yml --allow-publish --yes
npm trust github @ccdd/ccdd --repository=lhj6102/ccdd --file=release.yml --allow-publish --yes
```

npm requires account two-factor authentication for registration. The release
workflow uses OIDC; it does not require an npm token stored in GitHub secrets.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

### First publication of the umbrella

A new package name returning npm 404 is not a configured Trusted Publisher.
[npm trust requires an existing package](https://docs.npmjs.com/cli/v11/commands/npm-trust/).
Do not publish the current development-version umbrella or a placeholder. Wait
for the combined feature release, its final version and independently reviewed
main CI artifacts. Before that first umbrella release, an authorized package maintainer must publish
**the exact reviewed CI umbrella tarball**, not a placeholder or locally rebuilt
archive, using their ordinary npm authentication. Then configure its Trusted
Publisher in npm package settings: GitHub repository `lhj6102/ccdd`, workflow
`release.yml`, direct publication allowed. No new token is requested by CCDD.

The publisher checks every existing package's SHA-512 before writing anything.
It skips only identical already-published bytes, so rerunning the same release
can finish modules and announcement after a manual umbrella bootstrap. Normally
modules publish first; if the umbrella was bootstrapped first, users must wait
until all its exact dependency versions are confirmed before installing. A
partial release is not announced as complete. Never overwrite a published
version, publish a dummy version, or substitute a different CI artifact.

## Local verification and publication

The independent local release command remains available when publishing without GitHub Actions. It verifies an exact committed snapshot. You need Git, Node.js 22 LTS (22.19.0 or later), npm, dependency download access or a populated cache, an npm account with publication rights in the `@ccdd` organization, and a GitHub CLI (`gh`) login with write access to the origin repository.

CCDD 3.1.0 adds Node 22 LTS support and the MIT license. Older packages retain their original requirements. Run release verification locally with Node 22 LTS, selected by `.nvmrc`.

Keep all four package versions and the umbrella dependency versions and their lockfile entries aligned. Commit `docs/releases/v<version>.md` with the release notes and push the requested commit to origin. Published npm versions cannot be replaced; use a new coordinated version for changed package contents.

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

Local publication checks the GitHub source commit and tag, then the logged-in npm account and organization role before building. Build and test children receive isolated configuration without publisher or Provider credentials. The command clones the requested commit, installs locked dependencies, builds, runs the full test suite, packs all four packages, and verifies production installations and actual tool and Runtime behavior in separate projects. Uncommitted caller changes are excluded. No external LLM or desktop application is called by release verification.

Before writing to npm, every existing target package version must match the verified tarball's SHA-512 integrity. Matching versions are skipped; a mismatch stops publication. Packages publish in core → Project → default tools → umbrella order with public access and the `latest` npm tag. Fresh public metadata confirms each published version. npm scans accepted publishes before making them available, typically taking about five minutes and sometimes 15 minutes or more; see [npm's publish-time scanning announcement](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/). Confirmation checks every ten seconds for about twenty minutes per package, remains cancellable, and stops without claiming success if the version is still unavailable. Rerun after availability to continue with matching packages skipped.

**After all four exact package versions are confirmed, the same command creates or updates the matching GitHub Release.** Its tag points to the verified source commit and is never moved. The announcement includes the versioned npm install command, package links, and source-linked release notes. Its Node requirement comes from the verified Project tarball, so recovery of an older release retains that version's requirement. GitHub selects Latest on the server using its automatic version/date policy, so an older retry never explicitly overrides a newer announcement. Retrying an unchanged announcement performs no writes. Future versions keep their own announcement entries; historical tarball releases were removed once during the npm migration, preserving their Git tags and commit history.

This automation runs through `npm run release:npm` (equivalent to `npm run release -- --npm`). A manual `npm publish` outside this workflow does not update GitHub. GitHub notification behavior is documented in its [release API](https://docs.github.com/en/rest/releases/releases#create-a-release).

`--dry-run` performs build and package verification and `npm publish --dry-run`, with public metadata reads but no registry or GitHub writes and no login requirement. It does not guarantee account publication rights or successful 2FA. The legacy `npm run release -- --commit COMMIT_SHA --dry-run` remains available for local tarball verification alone; its former GitHub tarball publication path now stops with instructions to use npm.

## Recovering a partial publication

The four npm publications and the GitHub announcement are not one transaction. For GitHub Actions, rerun Release to reuse the verified CI artifact. For local publication, rerun the same commit with a new empty output directory. Identical versions already in npm are skipped. Never increment versions just to retry unchanged bytes.

If the publication scripts need a fix after tagging, merge and verify that fix first, then use the current workflow to publish the original tag:

```sh
gh workflow run release.yml --ref main -f tag=v6.2.0
```

This recovery uses the publication scripts from main and a separate checkout of the existing tag for release metadata. It still requires that tag's successful main CI and publishes only its retained, checksum-verified packages. It never moves the tag, rebuilds packages, or substitutes the workflow commit's packages. CI also checks each completed verification report with the same asset validator used by publication.

If npm succeeded but the GitHub announcement failed, use the retained verified files and the original source commit:

```sh
npm run release:npm -- --commit COMMIT_SHA --announce-only --assets-dir /tmp/ccdd-npm-release
```

This command requires GitHub authentication but no npm login. It loads metadata from the exact committed snapshot, validates the retained checksums and verification record, and confirms all four matching npm versions before any GitHub write. It does not rebuild or publish npm packages. A missing or mismatched package, moved source tag, or existing Release with uploaded assets stops the operation. The command never silently deletes historical downloads.

## Local verification files

These files remain local release evidence and recovery inputs:

| File | Purpose |
| --- | --- |
| `ccdd-ccdd-<version>.tgz` | Single-install facade with exact module dependencies |
| `ccdd-core-<version>.tgz` | Definition-only SDK package |
| `ccdd-project-<version>.tgz` | Project execution package |
| `ccdd-default-tools-<version>.tgz` | Optional default tool library |
| `verification.json` | Source commit, complete tests, and production installation evidence |
| `SHA256SUMS` | SHA-256 checksums of packages and verification record |

The [demo guide](demo.md) also supports these locally built tarballs. Preparing an existing demo again does not upgrade its packages; keep edited demos and use a new empty `--demo-dir`.

npm references: [publication and version immutability](https://docs.npmjs.com/cli/v11/commands/npm-publish/) and [public scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).
