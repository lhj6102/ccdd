# Designing reviewer tools

A reviewer tool is an API. It executes exactly what the reviewer requests and returns only that. It does not dump everything the project knows about an Artifact. Good design here is mostly subtraction.

This guide is for people and agents who build or audit a project's `views.agentTools`. The script protocol and limits are in [contracts](contracts.md#script-views); the [computed views example](../examples/computed-views/README.md) is a minimal working tool. An [agent brief](#agent-brief) is at the end.

## What the reviewer receives

- Every Artifact admitted to a review (the target, its instruction references, and their children and mounts) contributes its whole `agentTools` map. Each tool reaches the model as `<key>_<artifactName>`, with its `description` and its `inputSchema` as parameters. Two admitted Artifacts with the same tools send every definition twice.
- The system prompt embeds the final result schema: a `oneOf` of a GREEN branch built from `passSchema` and a RED branch built from `failSchema`. A field declared in both schemas is sent twice.
- The prompt holds the Critic `payload` (the instruction and any other fields, such as criteria) and CCDD's fixed review text.
- All of this is sent again on every model turn. Tool results stay in the conversation, so each later turn also carries every earlier result. `text` blocks arrive as written; `json` blocks arrive as compact JSON text.

Cost grows with static size times turns, plus each result times the turns after it. Fewer, smaller calls cut both.

## Surface

- **A few tools, one per question type.** For example `view` (what can be asked), `source` (what the Artifact claims) and `calculate` (what the behavior does). Fold variants of one question into an argument such as `mode`, not into separate tools.
- **Explicit free inputs.** Take the values the computation reads (levels, parameters, states), not presets or bundled profiles that hide what is computed. Do not fill missing inputs silently: require them, or report the value used.
- **A `select` argument.** The reviewer names the parts it needs. The default is the smallest useful part.
- **Batching.** One call takes several related requests, such as a variant and its parent. They share every other input by construction, so a comparison cannot mix conditions.
- **Per-Artifact schemas.** Where valid values are enumerable (slots, case IDs, state names, `select` parts), write them into that Artifact's schema as `enum`. The schema documents them, and CCDD rejects other values before the script runs. `ccdd.json` is static, so generate these declarations when you write the Artifact folders. An `enum` cannot be empty; omit the property when nothing is selectable.
- **A complete overview.** One `view` call lists every selectable value and every state the computation reads, with type, default and meaning, plus recommended inputs in the exact shape `calculate` accepts. If the list is small, return all of it; paging adds turns.
- CCDD validates arguments but does not apply schema `default` values. The script applies its own defaults.

A `calculate` input schema with these parts:

```json
{
  "type": "object",
  "properties": {
    "selections": {
      "type": "array", "minItems": 1, "maxItems": 16,
      "items": { "type": "array", "uniqueItems": true, "items": { "type": "integer", "enum": [1, 2, 3, 4, 5] } },
      "description": "Computed with otherwise identical inputs; [] is the base."
    },
    "level": { "type": "integer", "minimum": 1 },
    "states": {
      "type": "object",
      "additionalProperties": { "anyOf": [{ "type": "boolean" }, { "type": "number" }] },
      "description": "State ID to value, from view."
    },
    "select": {
      "type": "array", "minItems": 1, "uniqueItems": true,
      "items": { "type": "string", "enum": ["total", "cases", "cooldown", "hits.crit"] },
      "description": "Default total."
    }
  },
  "required": ["selections", "level", "states"],
  "additionalProperties": false
}
```

## Output

- **No request echo.** Report only derived values the reviewer could not know, such as an effective level or a defaulted input. In a batch, key each result by the item it answers.
- **No duplicates.** One representation per fact. Raw text, expanded text and resolved numbers are modes, not parts of one response.
- **No internal detail.** Drop internal IDs, debug strings, paging fields, fields at their default value and float noise.
- **Nothing outside the criteria.** A field no criterion reads costs tokens and invites off-scope findings.
- **Always surface warnings and unresolved references** when they are non-empty, whatever `select` says. Hiding them makes a partial result look complete.
- **Compact by default, provenance on request.** Formulas, sources and table lookups belong behind a mode or a `select` part.
- A single unconditional value is a plain number. List outcomes only when the value branches.
- Declare `"observation": "content"` and return `"observation": {"kind": "content"}` from successful calls that show Artifact content. Required observation counts only such calls.

## Descriptions

- One or two sentences: what the tool returns, and any rule needed to read it (units, the default, the inputs a mode requires).
- Say each thing once. Judgement rules belong in the instruction or criteria, output rules in the result schema descriptions, tool usage in the tool description. Do not restate CCDD's own prompt.
- Describe a property only when its name, type and `enum` do not already say it.
- Descriptions are at most 4,000 characters, and `{artifactName}` is the only brace allowed, so JSON examples do not fit.

## Errors

- Validate domain inputs in the script and return an authored error with exit 0: `{"isError": true, "content": [{"type": "text", "text": "..."}]}`. A thrown exception or nonzero exit reaches the reviewer only as a generic failure; CCDD withholds its text.
- Name the invalid input and the valid choices. `Invalid selection [1,2]: choose at most one slot per group (group 1: 1, 2, 3; group 2: 4, 5)` is actionable. `Invalid option selection` is not.
- Check every input before computing, and list only what is missing: `resolved needs level`.
- When a result would be too large, ask for less (`request fewer selections`). Never truncate silently.
- Never forward exception text, stderr or environment values, and never name tools that no longer exist.
- CCDD rejects schema violations before the script runs. Its message names the path and keyword, not the allowed values, so the reviewer finds those in the `enum`.

## Enforce the method structurally

An instruction alone does not make a reviewer follow a checking order. Make an invalid method impossible to report instead.

1. **Constrain claims in the result schema.** Each claim names what it was judged on, and only valid values are allowed: an `anyOf` inside `items`, one branch per claim, with `const` and an `enum` (enum values may be arrays).
2. **Make the valid method one call.** A batched `calculate` computes a claim and its reference together.
3. **Check that each claim was computed.** Declare `"resultCheck": {"script": "checks/result.mjs"}` on the Agent Critic. The script reads the schema-valid result and the recorded calls (`artifactId`, `operation`, `arguments`) on stdin. A call whose tool returned an authored error carries `isError: true`; keep only calls without it as evidence, for example the `selections` of every `calculate` call without `isError`. It prints `{"errors": [...]}`, such as `Option 4 was judged in [2, 4], which was never calculated.` Errors go to the reviewer through the one repair turn, which has no tools, so it can only correct a claim to a selection it did calculate. A second failure makes the review an error. The script is trusted owner code, not a sandbox. See [result checks](contracts.md#result-checks).

```json
"claims": {
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "option": { "type": "integer", "enum": [0, 1, 4] },
      "selection": { "type": "array", "items": { "type": "integer" }, "description": "The selection judged; its parent is the same without this option." },
      "verdict": { "type": "string", "enum": ["SAME", "DIFF"] }
    },
    "required": ["option", "selection", "verdict"],
    "additionalProperties": false,
    "anyOf": [
      { "properties": { "option": { "const": 0 }, "selection": { "enum": [[]] } } },
      { "properties": { "option": { "const": 1 }, "selection": { "enum": [[1]] } } },
      { "properties": { "option": { "const": 4 }, "selection": { "enum": [[1, 4], [2, 4]] } } }
    ]
  },
  "allOf": [
    { "contains": { "properties": { "option": { "const": 0 } } }, "maxContains": 1 },
    { "contains": { "properties": { "option": { "const": 1 } } }, "maxContains": 1 },
    { "contains": { "properties": { "option": { "const": 4 } } }, "maxContains": 1 }
  ]
}
```

Tool inputs and `passSchema`/`failSchema` share one schema dialect:

- Supported keywords: `type` (a single name), `properties`, `required`, `additionalProperties`, `items`, `contains`, `minContains`, `maxContains`, `enum`, `const`, `anyOf`, `oneOf`, `allOf`, `not`, `minItems`, `maxItems`, `uniqueItems`, `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `title`, `description`, `default` and `examples`. Nesting depth is at most 20.
- Any other keyword fails config validation, including `$ref`, `$defs`, `if`/`then`/`else`, `prefixItems`, `patternProperties` and `format`. Use `anyOf` instead of a type array. `minContains` and `maxContains` require `contains`.
- Each `allOf` entry above requires its option exactly once: `contains` demands at least one match, `maxContains` at most one.
- Without `$ref`, repeated subschemas are written out in full. A per-claim `enum` declared in both `passSchema` and `failSchema` is sent twice on every turn.
- A response schema cannot use composition at its top level, must omit `additionalProperties` or set it to false, and cannot declare reserved fields such as `verdict` or `toolCalls`.
- An invalid final result gets one repair turn without tools. The repair prompt names up to eight schema paths and keywords inside the branch of the returned verdict, such as `#/oneOf/1/properties/claims/items/anyOf/2/properties/selection` and `enum`, never the returned values. It follows an `anyOf` branch only when each branch fixes one property with `const`, as `option` does above; otherwise it names the `anyOf` itself.

## Tool changes and review identity

- **Default and `file-hash` identity.** The owning Artifact's identity covers its `ccdd.json` (every tool's description, schema and script), its local script entry files and the content of each `executionPaths` entry. A tool change gives that Artifact a new identity. Its Critics and every Critic that depends on it need new reviews.
- **Owner identity (`stale.kind: "identity"`).** Only the returned value counts. Tool, instruction and schema changes keep existing verdicts unless the value encodes them. A surface change that cannot change a correct verdict may keep the value; a change to what is computed must change it.
- Either way, review a few targets again after a redesign. A surface change should not flip verdicts.

## Measure

Compare before and after on the same targets, profiles and criteria.

1. **Static prompt per review.** `ccdd-project tools check --critic ARTIFACT/ID --json` lists the tools of every Artifact the review admits and reports `prompt`: `totalBytes` (system prompt, first prompt and tool definitions), `toolBytes` per Artifact, `payloadBytes` and `responseSchemaBytes`. These are the bytes CCDD passes to Pi before the first turn; each Provider adds its own framing.
2. **Output per call.** Take the recorded arguments of an earlier review from `run show RUN_ID --json` (`requests[].result.toolCalls[].arguments`, or `requests[].toolCalls[].arguments` for a review that ended in ERROR, such as a cancelled runaway). Replay each through `ccdd-project tools check --artifact ID --for agent --tool NAME --execute --args JSON` on both versions, and compare the bytes of `result.content`, counting `json` blocks as compact JSON. Same requests, different surface.
3. **Tokens and time per review.** Run one Critic fresh with `ccdd-project verify --critic ARTIFACT/ID --force --wait --json`, then read `run show RUN_ID --json`:
   - `executor.usage` events, one per model turn: sum `data.usage.totalTokens`, and keep `input`, `cacheRead` and `output` beside it, because Providers account for caching differently. `reasoning` is part of `output`.
   - `artifact.tool.completed` events, one per call, with `data.durationMs` and `data.contentBytes`.
   - The request's `startedAt` and `completedAt` for wall time.

A Run view keeps only its latest 500 events, so measure one Critic per Run. One review per profile is an indication, not a ranking; cache state varies between runs.

Protect large runs with a budget on the Agent profile, for example `"maxToolCalls": 40, "maxTokens": 400000` for tools that normally need 3–6 calls. A reviewer that loops then ends with `PROVIDER_BUDGET_EXCEEDED` instead of spending millions of tokens before its timeout, and `run show` still lists the calls it made as `requests[].toolCalls`. See [review budget](contracts.md#review-budget).

## Case study

A game damage simulator is reviewed skill by skill against each skill's tooltip text. A skill has up to eight options in three groups. The reviewer judges each option by comparing a selection with its parent, the same selection without that option. The first tool set had grown one tool per projection of the simulator's data.

The redesign kept three tools: `view`, `tooltip` with a `mode`, and `calculate` with explicit inputs, a batch of selections and `select`. It removed a character preset repeated in six tool schemas (37 KB of their 44 KB), request echoes, duplicate representations, debug strings, internal IDs, fields outside the criteria, and instruction text that repeated the criteria.

| Measure | Before | After |
| --- | ---: | ---: |
| Tools | 14 | 3 |
| Tool definitions | 50.6 KB | 3.9 KB |
| Static prompt | 64 KB | 17 KB |
| Output of equivalent calls | | 75–93% less |
| Tool calls per review | 15–25 | 3–6 |

One review per profile on the same skill:

| Profile | Tokens before → after | Wall time before → after |
| --- | ---: | ---: |
| Claude Sonnet 5.5, low | 234k → 43k | 49 → 17 s |
| Claude Sonnet 5.5, medium | 287k → 57k | 52 → 20 s |
| GPT-6.1 Sol, low | 155k → 20k | 201 → 52 s |
| GPT-6.1 Sol, medium | 101k → 27k | 200 → 64 s |

All verdicts agreed. The project uses owner identity and the redesign left its identity values unchanged, so existing verdicts stayed reusable.

Before the redesign, one reviewer judged later options alone and never computed their parents, although the instruction described the order. The fix was structural: the result schema allows only the valid selections for each option, the project validates them again after the review, and one `calculate` call computes an option together with its parent.

## Agent brief

Hand this to an agent that builds or audits a project's reviewer tools:

> Build (or audit) the reviewer tools of `ARTIFACT` for Critic `ARTIFACT/ID`. First read https://github.com/lhj6102/ccdd/blob/main/docs/reviewer-tools.md. Design a few request/response tools with explicit inputs, a `select` argument, batched related requests and per-Artifact `enum` values. Return only what was requested: no echoes, duplicates, internal IDs or fields no criterion reads, but always warnings and unresolved references. Return authored errors that name the invalid input and the valid choices. If the method has an order, enforce it in the result schema and check claims against the recorded tool calls during the review with `resultCheck`. Exercise each tool with `ccdd-project tools check --artifact ARTIFACT --for agent --tool NAME --execute --args JSON`. Measure before and after: the static prompt bytes from `ccdd-project tools check --critic ARTIFACT/ID --json`, the output bytes of recorded calls replayed through `tools check --execute`, and the tokens, turns and wall time of one fresh review per profile (`ccdd-project verify --critic ARTIFACT/ID --force --wait --json`, then `run show RUN_ID --json`). Do not change criteria or verdict rules to shrink output. Report the numbers, the verdicts before and after, each removed field with its reason, and whether the change alters review identity.
