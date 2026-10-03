# @ccdd/project

Project validation, review history, CLI, Broker, Executors and optional local monitor. Use Node 22 LTS, at least 22.19.0. Install with `npm install --ignore-scripts @ccdd/core@7.1.0 @ccdd/project@7.1.0`; default tools are optional and are not installed by Project. Regular dependencies install automatically; core is a non-optional peer, declared explicitly here to keep the installed versions aligned. See [installation choices](https://github.com/lhj6102/ccdd/blob/main/docs/getting-started.md#installation-choices).

Each folder with `ccdd.json` is an Artifact that owns its Critics and script views. Child folders, mounts and instruction references derive dependencies. Cycles are supported. By default, Critics wait for current GREEN evidence from dependencies outside their strongly connected component (SCC). SCC peers can execute together after external gates pass; final validation needs matching actual evidence throughout the required scope.

```sh
ccdd-project config check
ccdd-project status
ccdd-project plan implementation --recursive
ccdd-project verify implementation --recursive --wait
ccdd-project verify --critic implementation/tests --wait
ccdd-project run show RUN_ID
```

Individual verification preserves selected results and reports missing other required evidence as INCOMPLETE. `--recursive` includes that evidence's Critics. `--force` reevaluates selected Critics. Only matching explicit identity reuses actual GREEN/RED across projects; without a function there is no reusable cache; no stale state is persisted. Queries create no review tickets; current-input queries execute opted-in identity scripts. Static config discovery and monitor GETs do not run them.

State defaults to `~/.local/state/ccdd/<workspace-path-hash>`, configurable per repository with `--state-dir`. Keep `CCDD_STATE_HOME` shared across processes/repositories because it also selects the machine resource authority. State and all output must remain outside reviewed input. Reviews use the unchanged supplied workspace directly through execution and Human waiting. Users may provide a separate worktree with `--repo`.

With `--wait`: 0=fulfilled, 1=RED, 2=ERROR, 3=timeout, 4=incomplete. Without waiting, inspect the returned Run status; acceptance is not completion. `request claim`, `request tool` and `request submit` perform explicit local Human actions. `doctor`, `tools check` and `monitor` are supported.

`ccdd` exposes the same commands. There is no legacy run/config/group/generated compatibility path. Historical input versions are result-only, never reused or resumed. See the [repository guides](https://github.com/lhj6102/ccdd#readme).

## Review management

Use core `>=7.0.0 <8`; its declarations include identity weights, root review
policy and pinned script execution paths. All installed CCDD packages should
use the matching release. Stop all earlier-version workers before upgrading; completed
format-6 records remain history-only where readable. Previous input-version keys cannot be reused or resumed, and missing old provenance stays `null`.

Machine provider/model pools and weighted identities share one local authority.
`--max-executions` bounds durable submission starts; reuse consumes none.
`--concurrency` is only an additional tighter cap. `--identity-concurrency` is
removed: configure local identity capacity and per-Artifact `stale.weight`.
Original execution provenance and guarded `load-check` scenarios are documented
in [review management](https://github.com/lhj6102/ccdd/blob/main/docs/review-management.md).

## License

[MIT](LICENSE).

The 7.x cache contract is project-independent. Use the public prepared-submission, cursor/result stream, attempt summary and cache query APIs; see [migration](https://github.com/lhj6102/ccdd/blob/main/docs/migration-v7.md). Force bypass does not replace the shared result.
