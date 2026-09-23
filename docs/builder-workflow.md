# Builder workflow

1. Edit project material and its Artifact-owned `ccdd.json` declarations. Finish writes before requesting review.
2. Run `ccdd-project config check`. Use `doctor --critic artifact/id` for execution readiness and `tools check --artifact ID --for agent --tool NAME --execute --args JSON` for real tool behavior.
3. Run `ccdd-project verify ARTIFACT --recursive --wait --json`, or select one Critic with `--critic artifact/id`.
4. Read the recorded verdict and evidence. Fix semantic failures and submit a new verification. ERROR and wait timeout are not PASS.

Individual verification executes selected Critics immediately. A selected GREEN may coexist with final INCOMPLETE when other required evidence is absent. Recursive verification includes that dependency scope; matching evidence is reused. Cyclic relations run without PASS gates.

Supply a user-created worktree with `--repo` if you need to continue editing elsewhere. Keep credentials, state, result files, caches and tool output outside reviewed input. The worker monitors all input through execution and Human waiting. Changes invalidate unfinished review.

A useful builder instruction is:

> Implement the feature and satisfy `service/tests`. Check readiness, then run `ccdd-project verify --critic service/tests --recursive --wait --json`. Address concrete RED evidence; investigate ERROR separately. Report the qualified Critic ID, input identity, Run ID and final required-scope status. Do not invent a Provider or Human verdict.

See [reviewers](reviewers.md) and [Project Validation](project-validation.md).
