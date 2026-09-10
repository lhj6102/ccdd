# CCDD CLI demo

This guide assumes core, Project, and default tools installed using the [installation guide](getting-started.md) on Node 24 or later. Run the Project CLI; each scenario installs only the core and default-tools packages imported by its configuration. Agent scenarios require Pi Provider authentication and use the profile openai-codex / gpt-6-astra / medium. The CLI is sufficient for the demo; the monitor is optional.

The demo also needs two actual tarball files. Installing packages with `npm install` does not create them. First follow [Preparing tarballs from source](#preparing-tarballs-from-source) below, which writes matching core and default-tools tarballs to `/tmp/ccdd-local-packages`. The following commands use that exact output location. If you prepared packages elsewhere, substitute their absolute paths.

```sh
export CCDD_DEMO_CORE_TARBALL=/tmp/ccdd-local-packages/ccdd-core-3.0.0.tgz
export CCDD_DEMO_TOOLS_TARBALL=/tmp/ccdd-local-packages/ccdd-default-tools-3.0.0.tgz
export CCDD_DEMO_DIR="$HOME/.local/share/ccdd/demo-3.0.0"
export CCDD_CODEX_AUTH_FILE="$HOME/.codex/auth.json" # Example: explicitly bridge an existing Codex access token.
npx ccdd prepare-demo --demo-dir "$CCDD_DEMO_DIR"
npx ccdd doctor --demo --demo-dir "$CCDD_DEMO_DIR" --scenario fixed --json
```

This example uses a fresh `demo-3.0.0` folder. Omitting `--demo-dir` uses the existing default `~/.local/share/ccdd/demo-v9`. `v9` is the demo format version, separate from the CCDD package version. Earlier demo folders and user configuration are preserved. The four scenarios are separate folders without Git, and their current files can be edited directly. New demos import the separate default tool library in `ccdd.config.ts` and explicitly register Agent CLI reading/listing and Human desktop opening. The default Critics are two Agents and one Runtime; registering Human tools alone does not create Human requests.

Preparation installs dependencies once from the specified local tarballs, then physically copies them into each scenario. It does not assume public npm publication; installing public transitive dependencies may require network access or a local cache. All four projects retain their package locks, tarballs, and node_modules, so later snapshots can resolve tools without a parent project. Reusing an existing demo does not reinstall dependencies; choose an empty `--demo-dir` to test a new Release.

| Scenario | Maximum item count in Why / Spec / Tests / Implementation | Check |
| --- | --- | --- |
| baseline | 3 / 3 / 3 / 3 | Full consistency |
| why-change | 2 / 3 / 3 / 3 | Spec↔Why mismatch |
| runtime-failure | 2 / 2 / 2 / 3 | Actual runtime test failure |
| fixed | 2 / 2 / 2 / 2 | Full reevaluation after correction |

```sh
npx ccdd run --demo --demo-dir "$CCDD_DEMO_DIR" --scenario why-change --lock --critic spec-why --wait
npx ccdd run --demo --demo-dir "$CCDD_DEMO_DIR" --scenario runtime-failure --copy --critic implementation-tests --wait
npx ccdd run --demo --demo-dir "$CCDD_DEMO_DIR" --scenario fixed --copy --wait
```

Agent verdicts are actual Provider responses, not hardcoded expected outcomes from the table. Runtime executes actual Node tests. A standalone `--critic` verdict is distinct from a full-chain verdict.

Two `run --copy` requests against the same fixed folder may return different Handles sharing the same `workspace.path` and `snapshotHash`. Each review has its own result and output directory.

```sh
npx ccdd list --demo --demo-dir "$CCDD_DEMO_DIR" --scenario fixed
npx ccdd status RUN_ID --demo --demo-dir "$CCDD_DEMO_DIR" --scenario fixed
```

Editing the original during `--lock` causes an input-change ERROR. Editing the original after `--copy` preparation does not affect the active review, which continues against the copied content. Run `ccdd monitor --repo <scenario-folder>` separately to observe request state during the demo. Reviews continue after the monitor closes.

Agent Artifact tool names include `read_spec`, `list_tests`, and `read_tests`. Human tools `open_spec` and `open_tests` open files or folders in desktop applications instead of returning text. Default desktop integration targets macOS; specify an executable when using Human tools on other operating systems. The demo's markdown/code types contain per-operation description templates, with `{artifactName}` replaced by the actual ID. For example, `read_tests({path: "rank.test.mjs", startLine: 1, lineCount: 80})` reads a test file by line.

## Preparing tarballs from source

To test source under development instead of a Release, run the following in the CCDD repository. Then change the tarball environment variables above to the absolute paths of the generated files.

```sh
npm ci
npm run build
mkdir -p /tmp/ccdd-local-packages
npm pack --ignore-scripts --pack-destination /tmp/ccdd-local-packages
npm pack --workspace @ccdd/default-tools --ignore-scripts --pack-destination /tmp/ccdd-local-packages
export CCDD_DEMO_CORE_TARBALL=/tmp/ccdd-local-packages/ccdd-core-3.0.0.tgz
export CCDD_DEMO_TOOLS_TARBALL=/tmp/ccdd-local-packages/ccdd-default-tools-3.0.0.tgz
```

These commands pack the current source directly. To prepare source fixed to a commit with full tests and installation verification, use `npm run release -- --commit <40-character SHA> --dry-run --output-dir <empty-external-directory>` and select the two relevant tarballs from its output folder. See the [local release guide](releases.md#releasing-a-specific-commit-locally) for the full procedure.

Run the source CLI as `node dist/src/cli.js` instead of `npx ccdd`. Actual Agent diagnostics and reviews consume Provider usage. Local Release verification calls no external LLM; use this demo's `doctor` to check authentication and model access in the installation environment.
