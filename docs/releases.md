# Release installation and distribution

CCDD supports GitHub Release tarballs and publication to the public npm registry. Both release commands build and verify a specified commit locally without GitHub Actions. npm installation is available for versions whose initial publication has completed. See [getting started](getting-started.md) for the current installation flow, the [v2.0.2 release notes](releases/v2.0.2.md) for this release, and the [v2.0.1 release notes](releases/v2.0.1.md) for package renaming and migration.

## Distribution files

Since v2.0.0, the definition-only core and Project execution package are separate. Starting with v2.0.1, the packages and filenames use the `@ccdd` names below, with all three package versions released together. Historical distribution files retain their `lhj6102-ccdd-*` names. v1.1.0 had two packages: core and default tools.

| File | Purpose |
| --- | --- |
| `ccdd-core-<version>.tgz` | Definition-only SDK for Artifacts, Critics, relationships, and tools |
| `ccdd-project-<version>.tgz` | Pull validation, CLI, Broker, Executors, Artifact Runner, and monitor |
| `ccdd-default-tools-<version>.tgz` | Explicitly registered Agent read, list, and image observation tools and Human desktop tools |
| `verification.json` | Source and package installation verification record for the release |
| `SHA256SUMS` | SHA-256 checksums of the distribution files |

GitHub's separate Source code archives contain source; the `.tgz` files above are built installation tarballs. Projects using the default tool library install core, Project, and default tools from the same Release. Project and default-tools 2.x target core `>=2.0.0 <3`.

## Upgrading

Active reviews keep their original snapshots and implementations. Install the new version in the original project for subsequent requests. Existing review state, copies, and observation records are neither deleted nor converted.

1. Download the Release files into a new folder inside the project and verify the checksums.
2. Update local dependencies with `npm install --ignore-scripts <core.tgz> <project.tgz> <default-tools.tgz>`. Install only core and Project if you use custom tools exclusively. For definitions alone, only core is required.
3. For v2.0.1, apply the [npm package and import migration](releases/v2.0.1.md#migration). When coming from v1, also review [Project migration and verdict reuse](releases/v2.0.0.md#migrating-from-v1), then check with `npx ccdd-project config check` and `npx ccdd-project tools check`. When migrating from before v1.0.0, also apply the [configuration migration](releases/v1.0.0.md#migrating-existing-configuration).
4. In the environment that will run Agents, use `npx ccdd doctor` to check authentication, Provider, and model access before requesting a new review. Restart an active monitor with the new CLI.

`tools check --execute` actually runs the selected tool. `doctor` calls the actual Provider and consumes account usage. Successful release verification does not guarantee a user's authentication, model access, or desktop application installation.

Preparing an existing demo again does not automatically upgrade its packages. Keep edited demos and select a new empty folder with `--demo-dir`. The [demo guide](demo.md) has complete commands using Release tarballs.

## Releasing a specific commit locally

In the CCDD source repository, specify the **40-character commit SHA** to release. You need Node 24 or later, Git, npm, and network access or a local cache for installing package dependencies. Publication uses an existing GitHub CLI (`gh`) login and verifies that the specified commit exists in the `origin` repository.

```sh
# Replace COMMIT_SHA with the 40-character commit SHA to release.
npm run release -- --commit COMMIT_SHA --dry-run --output-dir /tmp/ccdd-v2.0.2-check
npm run release -- --commit COMMIT_SHA --output-dir /tmp/ccdd-v2.0.2-release
```

These commands can be run independently. `--dry-run` performs all verification and creates distribution files without requiring GitHub authentication. Run the command without `--dry-run` to publish; it verifies the commit again. `--output-dir` is optional; when supplied, it must name an empty directory outside the repository. Use previously unused paths for the examples above as well.

The command creates a temporary clone and checks out the specified commit in detached mode. There it runs `npm ci`, the build and full test suite, creates three tarballs, and verifies actual installation, tool execution, and Runtime validation in separate projects. Uncommitted changes in the current working directory are excluded from the release. After verification passes, it creates a version tag at that commit and uploads files to a GitHub Release. `verification.json` records the source commit and verification environment; `SHA256SUMS` records file integrity.

An already published version is skipped unchanged. A tag pointing to another commit is rejected and never moved. If a Draft for the same commit remains, rerun the command to retry publication. To change published distribution files, increment all three package versions together and release a new commit.

Keep the core, Project, and default-tools `package.json` versions and lockfile versions aligned, and include `docs/releases/v<version>.md` in the commit. That document becomes the Release body. v2.0.2 uses [these release notes](releases/v2.0.2.md).

Build and verification run on the computer executing the command, without GitHub Actions. The GitHub release command above does not publish to npm. Neither distribution path calls an external LLM, so neither consumes Actions execution time or Provider usage; both require local execution time and dependency downloads.

## Public npm publication

The three packages are published to `https://registry.npmjs.org/` with `public` access and the `latest` tag. Anyone can download published npm package files regardless of the GitHub repository's visibility. You need an npm account with publication rights in the `@ccdd` organization. Logging in as the personal account `lhj6102` alone does not grant access to the `@ccdd` scope.

```sh
nvm use # With nvm, select Node 24 from .nvmrc.
npm run release:npm:check
# Use the 40-character SHA of a commit containing npm publication configuration.
npm run release:npm -- --commit COMMIT_SHA --dry-run --output-dir /tmp/ccdd-npm-check

# Actual publication uses local npm authentication and, when required, 2FA.
npm login --registry=https://registry.npmjs.org/
npm run release:npm -- --commit COMMIT_SHA --output-dir /tmp/ccdd-npm-release
```

`release:npm:check` checks Node/npm versions, the logged-in account, email verification, 2FA settings, and the `ccdd` organization role through read-only operations. It does not print account tokens or email addresses. If it reports `Scope not found`, first check creation of the `ccdd` organization or access to the existing organization. On npm's Add an Organization page, you can select the name `ccdd` and the free plan for public packages. The creation page confirms whether the name is available. See [npm's organization creation guide](https://docs.npmjs.com/creating-an-organization/).

`release:npm` is equivalent to `release --npm`. Actual publication must pass the same environment checks before building. It installs, builds, and runs the full test suite for the specified commit in a temporary clone, then checks the three tarballs' file lists and checksums and tests actual installation, tools, Runtime, and validation reuse in separate projects. It passes the exact verified tarball bytes to `npm publish --ignore-scripts --access=public`. No GitHub authentication or Release creation is required. Only the publication process receives npm credentials; the build and tests do not.

`--dry-run` performs the same verification and finishes by running `npm publish --dry-run` for each tarball. Network access is needed for public npm metadata and dependencies, but no npm login or registry writes occur. This check does not guarantee the actual account's publication rights or successful 2FA.

Before publication, the command queries the target version of all three packages. If an existing version's SHA-512 integrity matches the verified tarball, it is skipped; if it differs, the command exits without publishing any new package. Publication proceeds core → Project → default tools and checks registry integrity. After a partial failure, rerun with the same commit to publish the remaining packages. If specifying an output path, use a new empty path for the retry. Publication of all three packages is not one transaction, so some may become visible before the process completes.

Published version contents cannot be replaced. To provide the same distribution files on GitHub and npm, update the versions of all three packages and the lockfile together, commit new release notes, and specify the same commit for both commands. Existing GitHub Release tarballs contain `private: true` and cannot be published directly to npm unchanged.

After publication, check the versions and install matching package versions:

```sh
npm view @ccdd/core version --registry=https://registry.npmjs.org/
npm view @ccdd/project version --registry=https://registry.npmjs.org/
npm view @ccdd/default-tools version --registry=https://registry.npmjs.org/
# Replace VERSION with the matching version confirmed for all three packages above.
npm install --ignore-scripts @ccdd/core@VERSION @ccdd/project@VERSION @ccdd/default-tools@VERSION
```

npm behavior references: [publication and version immutability](https://docs.npmjs.com/cli/v11/commands/npm-publish/) and [public scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).
