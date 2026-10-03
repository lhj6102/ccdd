# CCDD as a local computing resource

CCDD 7 maps **an explicit identity to a completed result**. The cache is shared
by all projects using the same local user's CCDD state home. It is not a
repository registry, worktree coordinator, or model/profile equivalence engine.

## The contract

| Request | Behavior |
| --- | --- |
| No explicit identity function | Execute and return; do not read, write or join the reusable cache. |
| Identity has a completed entry | Return the original completed result. |
| Identity has an active computation | Subscribe to that computation, without starting another review. |
| Identity is absent from both | Execute once and publish a completed result. |
| Operational failure or cancellation | Do not publish it as a semantic cache result. |
| Explicit force | Execute without reading, joining or replacing the shared cache. |

GREEN and RED are equally reusable. RED still fails validation. Repo, path,
worktree, Critic ID, profile, criteria, schema, runtime version, integrity policy
and dependency identities are **not** added to the cache key. The owner function
must include every distinction for which one result cannot replace another.
Even a changed schema or a more expensive profile does not override an identity
hit. Queries expose the original result and actual profile, not invented output
from the new requested profile.

In the Project adapter an identity strategy belongs to an Artifact. All Critics
of that Artifact receive its returned identity. Giving different Critics the
same value intentionally declares their results interchangeable. Use an
appropriate declaration/identity design when their results are not equivalent;
CCDD will not silently salt their keys with their Critic IDs.

Content fingerprints, SCCs and workspace descriptors still exist for execution
safety, graph traversal and historical inspection. They are not implicit reusable
identities. `file-hash`, `always`, or omission of `stale` do not enable caching.
A completed noncached result remains in its own Run history, but a later
current-input query cannot reuse it. Use `run show` to inspect that execution.

## Supply an identity

Inside an Artifact's `ccdd.json`:

```json
"stale": {
  "kind": "identity",
  "script": { "command": "node", "args": ["identity.mjs"] },
  "inputs": ["input.json"],
  "timeoutMs": 30000
}
```

An example owner function that identifies the complete input and this specific
review protocol:

```js
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const input = await readFile('input.json');
console.log(createHash('sha256').update('my-review-protocol-v1\0').update(input).digest('hex'));
```

The protocol label is chosen by the owner, not injected by CCDD. Include model,
criteria, dependencies or other data only when they affect substitutability.
The function receives versioned JSON on stdin, including the Artifact ID and
family metadata where applicable. It runs from the owner folder with scoped
entry/inputs, filtered environment and disposable external outputs.

Output is 1-128 characters from `[A-Za-z0-9._:-]` plus at most one trailing LF.
An invalid value, script failure, timeout or input mutation fails preparation;
it never falls back to another key or silently starts an uncached paid review.
See [the exact script contract](contracts.md#owner-defined-identity).

## Location, access and lifetime

The default location is `~/.local/state/ccdd/identity-cache`, or
`$CCDD_STATE_HOME/identity-cache`. Unrelated projects use it automatically. A
project's `--state-dir` still locates its Run receipts and history; it does not
partition the cache. A read hit does not require the original repository or its
project state directory. Results and provenance are owned by the cache, and
shared executions have separate audit storage under its execution directory.

The boundary is the local OS user's trusted storage. This is not a cross-user
public cache or an isolation mechanism for hostile local applications. Do not
put credentials in identities or semantic result fields. Retained JSON does not
make arbitrary paths inside an owner's result portable: return self-contained
semantic data rather than expecting a path in a deleted repository to exist.

The first requester does not own the shared computation's lifetime. Canceling
one subscriber detaches it; other subscribers can still receive the result.
When all subscribers cancel, the execution is aborted. A lost owner cannot
publish over a replacement owner. Human claims/tools/completion are forwarded
to the cache-owned execution rather than depending on the initiating receipt.
The monitor lists that execution's Human tools. A worker whose Run is terminal,
including a canceled initiating Run, keeps serving the shared executions it owns
until they complete. An explicitly stopped worker or closed Broker drains them for
up to 10 seconds, then aborts them with `COMPUTE_OWNER_EXITED`; a remaining
subscriber executes the identity again and any Human claim starts over. Subscribers receive a redacted operational error; the initiating receipt
keeps its own execution's message.

A cache-owned execution keeps the initiating Run's root
`reviewPolicy.maxConcurrentExecutors` cap. A retried subscriber executes its own
requested profile, not the profile of the shared execution it joined.

A cache hit or follower does not consume an executor start. An execution owner
uses the initiating submission's durable budget; a later independent retry
cannot spend the earlier caller's allowance. Provider turn recovery stays inside
the same bounded review, without resetting its deadline or replaying tools.
External Provider delivery or charging is not guaranteed exactly-once.

## Public cache operations

These require no repository and always emit JSON:

```sh
ccdd cache show ID
ccdd cache list --limit 100
ccdd cache list --after LAST_ID --limit 100
ccdd cache compare LEFT_ID RIGHT_ID
ccdd cache gc --limit 128
ccdd cache delete ID
```

`--cache-dir PATH` selects an explicit cache for these operations. `show`, `list`
and `compare` are readonly, create no missing store and do not update access
metadata. Missing `show`/`compare` entries return exit code 4. Comparison is
informational: it never invalidates, reruns or replaces results.

The public Project package exports `openIdentityCache`, `readIdentityCache`,
`listIdentityCache`, `cachedResultView`, `compareIdentityCache` and their types.
The same exports are available through `@ccdd/ccdd/project`. Stored output
includes original execution ID, result, profile, provenance and reported usage;
unreported usage is not converted to zero.

## Garbage collection

Default retained JSON limits are 1 GiB total, 10,000 entries and 16 MiB per entry.
The SDK accepts explicit limits. Oversized results can be returned to waiting
callers without being retained as reusable entries. Capacity and recent use
control eviction, not repository existence, profile drift or semantic age.
There is no automatic semantic TTL.

GC does bounded work, protects active subscribers and reclaims retired
cache-owned execution directories separately from its short DB transactions.
Its response includes `needsMore` when another bounded pass is required. Cache
hits batch their recent-use bookkeeping rather than synchronously writing on
every hit. Returned JSON is detached from storage and remains usable after GC.

These JSON budgets are not a hard limit on peak disk consumption by active
execution scratch directories. Cache data and its execution audit are not a
permanent archive. Project Run receipts retain their own recorded semantic
results; archive any external audit material separately when permanence is
required. Explicit deletion rejects active computations instead of disrupting
their subscribers.

## Provider recovery belongs to CCDD

Provider/account lanes share a cooldown and authentication/quota stop state.
Ordinary transient rate limits, retryable server failures and transport errors
are handled by the Pi turn wrapper, with at most three attempts, bounded backoff
and a single original review deadline. `Retry-After` is respected within that
deadline. Recovery does not select another model or re-execute already-delivered
tools or partial output. A turn with delivered content or positive usage is not
blindly replayed. Exhausted recovery returns an operational error, not RED.

Authentication failure and exhausted quota stop that account lane. Other account
lanes are independent. Raw credentials are not persisted in the coordinator.
After correcting the account, inspect and explicitly resume:

```sh
ccdd provider status
ccdd provider resume PROVIDER
```

Resume clears that Provider's lane blocks/cooldowns; it does not fabricate a
result or silently restart already failed reviews. Retry the affected request
explicitly, retaining its durable execution budget. New submissions then use
the recovered lane normally. Permanent malformed requests fail without an
unbounded retry loop. No project-specific retry wrapper is required.
