# Releases and npm installation

CCDD packages are distributed through npm. GitHub Releases announce each version with an installation command, npm package links, and release notes. They do not host installation tarballs. GitHub still supplies automatic Source code archives; those contain source, not installable packages.

See [getting started](getting-started.md) for setup and [v3.0.0 release notes](releases/v3.0.0.md) for the current changes.

## Installing and upgrading

Use Node.js 24 or later and install matching versions of the three packages:

```sh
npm install --ignore-scripts @ccdd/core@3.0.0 @ccdd/project@3.0.0 @ccdd/default-tools@3.0.0
npx ccdd-project config check
npx ccdd-project tools check
```

`@ccdd/core` supplies definitions. `@ccdd/project` supplies validation, the CLI, Broker, Executors, and monitor. `@ccdd/default-tools` is optional when all tools are custom. Project and default-tools 3.x target core `>=3.0.0 <4`.

Active reviews retain their original snapshots, implementations, and actual evidence. Install the new version in the original project for subsequent requests and restart an active monitor with the new CLI. Review state and copies are not deleted or converted.

For older projects, follow the [package and import migration](releases/v2.0.1.md#migration), [Project migration from v1](releases/v2.0.0.md#migrating-from-v1), and, when needed, [configuration migration from before v1](releases/v1.0.0.md#migrating-existing-configuration). Use `npx ccdd doctor` in the Agent environment to check actual authentication, Provider, and model access. It calls the Provider and consumes account usage. `tools check --execute` actually runs the selected tool.

## Publishing a version

Releases build and verify an exact committed snapshot locally, without GitHub Actions. You need Git, Node.js 24 or later, npm, dependency download access or a populated cache, an npm account with publication rights in the `@ccdd` organization, and a GitHub CLI (`gh`) login with write access to the origin repository.

Keep all three package versions and their lockfile entries aligned. Commit `docs/releases/v<version>.md` with the release notes and push the requested commit to origin. Published npm versions cannot be replaced; use a new coordinated version for changed package contents.

```sh
nvm use # With nvm, select Node 24 from .nvmrc.
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

Actual publication checks npm authentication and the GitHub source commit and tag before building. Build and test children receive isolated configuration without publisher or Provider credentials. The command clones the requested commit, installs locked dependencies, builds, runs the full test suite, packs all three packages, and verifies production installations and actual tool and Runtime behavior in separate projects. Uncommitted caller changes are excluded. No external LLM or desktop application is called by release verification.

Before writing to npm, every existing target package version must match the verified tarball's SHA-512 integrity. Matching versions are skipped; a mismatch stops publication. Packages publish in core → Project → default tools order with public access and the `latest` npm tag. Fresh public metadata confirms each published version; short registry propagation delays are retried.

**After all three exact package versions are confirmed, the same command creates or updates the matching GitHub Release.** Its tag points to the verified source commit and is never moved. The announcement includes the versioned npm install command, package links, and source-linked release notes. GitHub selects Latest on the server using its automatic version/date policy, so an older retry never explicitly overrides a newer announcement. Retrying an unchanged announcement performs no writes. Future versions keep their own announcement entries; historical tarball releases were removed once during the npm migration, preserving their Git tags and commit history.

This automation runs through `npm run release:npm` (equivalent to `npm run release -- --npm`). A manual `npm publish` outside this workflow does not update GitHub. GitHub notification behavior is documented in its [release API](https://docs.github.com/en/rest/releases/releases#create-a-release).

`--dry-run` performs build and package verification and `npm publish --dry-run`, with public metadata reads but no registry or GitHub writes and no login requirement. It does not guarantee account publication rights or successful 2FA. The legacy `npm run release -- --commit COMMIT_SHA --dry-run` remains available for local tarball verification alone; its former GitHub tarball publication path now stops with instructions to use npm.

## Recovering a partial publication

The three npm publications and the GitHub announcement are not one transaction. If publication stops partway through npm, rerun the same commit with a new empty output directory. Identical versions already in npm are skipped. Never increment versions just to retry unchanged bytes.

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
