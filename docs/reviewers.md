# Agent and Human reviewers

A folder's `ccdd.json` owns its Critics and audience-specific tools. Keep the view scripts, declared execution inputs and review material in the supplied workspace. Keep credentials and writable state outside it.

## Agent

The [custom-reader example](../examples/custom-text-reader/README.md) uses `{spec}` and `{why}` in its Critic instruction. CCDD derives the reference and binds each folder's Agent tools. Existing brace escapes remain literal. A mounted alias works the same way; descriptions use only the separate `{artifactName}` placeholder.

Agent profiles specify `kind`, `provider`, `model`, `reasoning` and optional `timeoutMs`. The requested settings are used for the actual Pi evaluation. For example:

```json
{"kind":"agent","provider":"openai-codex","model":"gpt-6-astra","reasoning":"medium"}
```

```sh
ccdd-project doctor --critic spec/alignment --codex-auth-file /external/auth.json
ccdd-project tools check --artifact spec --for agent --tool read --execute --args '{"startLine":1,"lineCount":20}'
ccdd-project verify spec --recursive --wait --codex-auth-file /external/auth.json
```

Use `--pi-auth-file`/`CCDD_PI_AUTH_FILE` for a Pi auth store, or `--codex-auth-file`/`CCDD_CODEX_AUTH_FILE` to bridge an existing Codex auth file read-only. Credentials must never be inside reviewed input. Doctor makes a real Provider call with a private nonce outside the project; it does not evaluate project quality or substitute for the actual Critic.

Agents receive only scoped tools and return structured GREEN/RED plus fields required by the Critic's optional passSchema/failSchema (verdict-only when no schema applies). Each target and explicit instruction reference must have a successful content or empty observation. Listing files, mentioning a reference or launching an app does not count. An admitted child or mount is not automatically a mandatory observation. Image views require a model supporting image input.

## Human

Set a Critic profile to `{"kind":"human"}` and register `views.humanTools`. These can return text/JSON/images or launch a local desktop application. [Default tools](../packages/default-tools/README.md) and [computed views](../examples/computed-views/README.md) show both forms.

```sh
ccdd-project verify spec --human-inbox
ccdd-project monitor
```

The monitor can show the request, reserve a Try Claim, prepare input/environment, confirm the claim, call its registered views and submit the reviewer's result. The worker remains alive throughout. There is no remote transfer or downloaded workspace. A failed preparation releases the reservation; it never fabricates a verdict.

Equivalent local CLI actions are:

```sh
ccdd-project request claim REQUEST_ID --reviewer me
ccdd-project request tool REQUEST_ID --reviewer me --tool read_spec --args '{"path":"spec.md"}'
ccdd-project request submit REQUEST_ID --reviewer me --result-file /external/result.json
```

The tool name and arguments depend on the declared view. The result file contains the person's actual `{"verdict":"GREEN"}` or `{"verdict":"RED"}`, plus any fields required by the corresponding declared owner response schema (for example `{"verdict":"RED","reasons":["Unmet requirement"]}` when failSchema declares reasons). A launch receipt alone never completes a review. Only the current claimant can call Human tools or submit results, and completion requires a live worker and unchanged input.

## Local environment checks

An Artifact may own `envRequirements: {"viewer": {"description":"Viewer available", "script":"checks/viewer.mjs", "timeoutMs":30000, "inputs":["checks/settings.json"]}}`. Paths here are relative to that folder. A zero exit means ready. Checks run only during explicit Human preparation and only for admitted Artifacts; queries and monitor GETs do not execute them. Scripts receive external output/temp paths and an allowlisted environment. CCDD does not install missing tools automatically.

See [Human lifecycle contracts](contracts.md#human-lifecycle) for reservations, expiry, authoritative completion and input mutation behavior.
