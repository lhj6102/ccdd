# Default image tool and Artifact groups

The `effect` document and `preview` image are independent Artifacts. `explosion` is a group referencing both IDs, with no path or type. Tools for the document and image are explicitly registered. This example is a static sample, not an actual VFX asset.

- `preview-review`: Evaluates one image. Only `view_image_preview` is supplied.
- `explosion-review`: Evaluates the group. `read_effect` and `view_image_preview` are supplied. Tools are not duplicated when `preview` is both a member and a dependency.
- `explosion-human`: Opens the group's document and image in desktop applications, then accepts a submitted verdict.

In a full Run, both group Critics must wait for the image review to pass because of explicit `deps: ['preview']`. Membership alone does not require prior evaluation. Once both group Critics are GREEN, `explosion` is GREEN while `effect` remains unreviewed.

## Running the example

Install the three v3.0.0 packages on Node 24 or later. The following command works after npm publication; before that, use the local source build below. Start in the CCDD source repository and copy the example into a new project outside it.

```sh
CCDD_EXAMPLE_ROOT=$(mktemp -d /tmp/ccdd-groups.XXXXXX)
cp -R examples/artifact-groups "$CCDD_EXAMPLE_ROOT/project"
cd "$CCDD_EXAMPLE_ROOT/project"
npm init -y
npm pkg set type=module
npm install --ignore-scripts @ccdd/core@3.0.0 @ccdd/project@3.0.0 @ccdd/default-tools@3.0.0

# Check group member tool readiness without calling a Provider.
npx ccdd tools check --artifact explosion --for agent
# Select an individual Artifact for actual image reading.
npx ccdd tools check --artifact preview --for agent --tool view_image --execute

# Review one Critic; this legacy command skips waiting for prerequisite verdicts.
npx ccdd run --copy --critic explosion-review --codex-auth-file "$HOME/.codex/auth.json" --wait
```

Actual Agent review requires authentication and access to a model supporting image input. See the [reviewer guide](../../docs/reviewers.md) for authentication methods. Tool checks do not call a model. The `--execute` output above includes actual image blocks in base64.

If core is already installed, change the first `cp` source to `node_modules/@ccdd/core/examples/artifact-groups`.

Start a full Run with Human review by registering a local notification:

```sh
npx ccdd run --copy --human-inbox --codex-auth-file "$HOME/.codex/auth.json"
npx ccdd monitor
```

Select a project and Run in the monitor, then click the group node in Graph to inspect its members. Claim the Human request, click `{explosion}`, execute each member's `open` tool, and submit a verdict with evidence. Default desktop opening targets macOS; explicitly register an executable on other operating systems.

`view_image` reuses Pi `read` image results. It detects PNG/JPEG/WebP from file content, with a 4MiB limit. GIF, BMP, animated PNG, and text results fail; no automatic conversion or resizing occurs. When registered on a directory Artifact, pass an internal path such as `{"path":"frames/preview.png"}`.

## Using a local source build

To test modified source, prepare three tarballs in the CCDD repository:

```sh
npm ci
npm run build
CCDD_LOCAL_PACKAGES=$(mktemp -d /tmp/ccdd-group-packages.XXXXXX)
npm pack --ignore-scripts --pack-destination "$CCDD_LOCAL_PACKAGES"
npm pack --ignore-scripts --workspace @ccdd/project --pack-destination "$CCDD_LOCAL_PACKAGES"
npm pack --ignore-scripts --workspace @ccdd/default-tools --pack-destination "$CCDD_LOCAL_PACKAGES"
```

In the same shell, create the new example project from the steps above, then replace the npm version installation with `npm install --ignore-scripts "$CCDD_LOCAL_PACKAGES"/*.tgz`. Subsequent tool checks and review commands are the same. To also run the full test suite and separate installation checks on source fixed to a commit, use `--dry-run` with the [local Release command](../../docs/releases.md#releasing-a-specific-commit-locally).
