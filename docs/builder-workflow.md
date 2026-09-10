# Iterating until a selected Critic passes

This guide describes the legacy `ccdd run --critic` workflow, which evaluates a selected Critic independently. For new projects, use [Project Validation](project-validation.md), whose `ccdd-project verify --critic` enforces dependency gates. For Agent credentials and Human reviews, see [Choose a reviewer](reviewers.md).

The Requester owns Builder generation and revision loops. CCDD executes the selected Critic and returns its verdict and evidence.

Explicitly register tools in `ccdd.config.ts` and install required packages inside that project. The Provider diagnostic in `doctor` checks connectivity using an internal nonce. Separately check actual custom project tool execution with `tools check --artifact ID --for agent --tool NAME --execute --args JSON`. This diagnoses fresh input; it does not open a historical request's snapshot.

```sh
ccdd doctor --repo /path/to/repo --critic tests-spec --json
ccdd run --repo /path/to/repo --copy --critic tests-spec --wait --json
```

1. Edit the current working directory. No commit is required.
2. Request a review with `--copy`. You can edit the original after the copy completes, but the result is a verdict on the hash captured for the request.
3. GREEN means the selected criterion passed. For RED, read `requests[0].result.evidence`, make changes, and create a new Run.
4. For ERROR, resolve configuration, connection, input mutation, or execution failures. A wait timeout is not a failed verdict; query the existing Handle.

```sh
ccdd status RUN_ID --repo /path/to/repo --wait --timeout-ms 600000
ccdd cancel RUN_ID --repo /path/to/repo
```

`--wait` uses 0=GREEN, 1=RED, 2=ERROR, and 3=wait timeout. For `run` without `--wait`, 0 means successful acceptance, and an independent worker continues execution. No server is required to query `status`.

Choose `--lock` if you can stop all changes to the working directory and want to avoid copying. Editors, Builders, and other processes must not modify the input until the review finishes. Write output and temporary files to `CCDD_OUTPUT_DIR` and `CCDD_TMP_DIR`.

Example instructions for a Builder:

> Implement the feature and pass the `tests-spec` Critic. Use doctor to confirm that this Critic is ready for actual execution. Run `ccdd run --copy --critic tests-spec --wait --json` against the modified current workspace. If RED, address the evidence and submit a new request. Do not treat ERROR or wait timeout as a pass. Include the Critic ID, input hash, and Handle in the completion report.
