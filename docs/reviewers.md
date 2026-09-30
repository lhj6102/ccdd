# Agent and Human reviewers

A folder's `ccdd.json` owns its Critics and audience-specific tools. Keep the view scripts, declared execution inputs and review material in the supplied workspace. Keep credentials and writable state outside it.

## Agent

The [custom-reader example](../examples/custom-text-reader/README.md) uses `{spec}` and `{why}` in its Critic instruction. CCDD derives the reference and binds each folder's Agent tools. Existing brace escapes remain literal. A mounted alias works the same way; descriptions use only the separate `{artifactName}` placeholder.

Agent profiles specify `kind`, `provider`, `model`, `reasoning` and optional `timeoutMs`. The requested settings are used for the actual Pi evaluation. For example:

```json
{"kind":"agent","provider":"openai-codex","model":"gpt-6-astra","reasoning":"medium"}
```

An optional budget stops a runaway review before the wall-clock timeout: `maxToolCalls` counts every tool call the model makes, and `maxTokens` counts Pi's reported `totalTokens` per model turn. The call or turn that exceeds either limit ends the review with `PROVIDER_BUDGET_EXCEEDED`, never a verdict, and its [tool-call record](contracts.md#requester-results-and-audit-lookup) is kept. Both are unset by default.

```json
{"kind":"agent","provider":"anthropic","model":"claude-sonnet-5-5","reasoning":"low","maxToolCalls":40,"maxTokens":400000}
```

```sh
ccdd-project doctor --critic spec/alignment --codex-auth-file /external/auth.json
ccdd-project tools check --artifact spec --for agent --tool read --execute --args '{"startLine":1,"lineCount":20}'
ccdd-project verify spec --recursive --wait --codex-auth-file /external/auth.json
```

Use `--pi-auth-file`/`CCDD_PI_AUTH_FILE` for a Pi auth store, or `--codex-auth-file`/`CCDD_CODEX_AUTH_FILE` to bridge an existing Codex auth file read-only. Credentials must never be inside reviewed input. Doctor makes a real Provider call with a private nonce outside the project; it does not evaluate project quality or substitute for the actual Critic.

Agents receive only scoped tools and return structured GREEN/RED plus fields required by the Critic's optional passSchema/failSchema (verdict-only when no schema applies). Each target and explicit instruction reference must have a successful content or empty observation. Listing files, mentioning a reference or launching an app does not count. An admitted child or mount is not automatically a mandatory observation. Image views require a model supporting image input.

To keep those tools small and their results focused, see [designing reviewer tools](reviewer-tools.md).

### Native Pi model profiles and transport

The installed Pi catalog provides these exact profiles, without local model aliases:

```json
{"kind":"agent","provider":"openai-codex","model":"gpt-6-luna","reasoning":"xhigh"}
{"kind":"agent","provider":"opencode-go","model":"deepseek-v4.1-flash","reasoning":"high"}
```

DeepSeek V4.1 Flash supports `low`, `high` and `max`; `xhigh` is rejected before
transport rather than clamped. Luna keeps the requested `xhigh`. These effort
names do not establish equal reasoning budgets or quality across models.

With Pi 0.99.1 the catalog also provides these exact profiles:

```json
{"kind":"agent","provider":"openai-codex","model":"gpt-6.1-sol","reasoning":"xhigh"}
{"kind":"agent","provider":"anthropic","model":"claude-sonnet-5-5","reasoning":"high"}
```

GPT-6.1 Sol supports `minimal` through `max`; Claude Sonnet 5.5 supports `low`
through `max` and rejects `off` and `minimal`. The Anthropic Provider reads a
stored `anthropic` entry (`api_key` or `oauth`) from an external Pi auth file passed
through `--pi-auth-file`, or `ANTHROPIC_API_KEY` / `ANTHROPIC_OAUTH_TOKEN` /
`ANTHROPIC_AUTH_TOKEN` from the environment. Create an OAuth entry yourself with
`npx @earendil-works/pi-ai@0.99.1 login anthropic`, which writes `auth.json` in the
current directory; move it outside the workspace. Expired OAuth entries are rejected
rather than refreshed.

OpenCode Go accepts an API key from `OPENCODE_API_KEY` or the `opencode-go` entry
in an external Pi auth file passed through `--pi-auth-file`. Do not put credentials
in `ccdd.json`, reviewed material or logs. CCDD's explicit credential stores remain
read-only: renewal belongs to the issuing login tool, not to a review worker.

The native Pi Provider wrapper supplies OpenCode's `x-opencode-session` header
from the review session ID. It remains stable through tool turns and the single
format-repair continuation; different reviews use different IDs. Pi supplies its
own identifiable User-Agent, not another client's identity. See the
[OpenCode Go client requirements](https://opencode.ai/docs/go/).

HTTP-adapter regressions use intercepted fetch responses, synthetic credentials
and actual local tools. They cover serialized headers and reasoning/tool history,
SSE parsing, final JSON repair, cancellation and read-only authentication. They
are offline transport evidence, not a claim of live Provider access or model quality.
See the [executor identity limitation](../src/executors/CONTEXT.md#provider-identity-visibility):
the current Pi Codex parser does not expose server response-model metadata, so
missing identity is unknown rather than server-model attestation.

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
