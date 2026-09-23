# @ccdd/project

Version 4 project validation, review history, CLI, Broker, Executors and optional local monitor. Use Node 22 LTS, at least 22.19.0. Install with `npm install --ignore-scripts @ccdd/core@^4 @ccdd/project@^4`; default tools are optional.

Each folder with `ccdd.json` is an Artifact that owns its Critics and script views. Child folders, mounts and instruction references derive dependencies. Cycles are supported. A ready Critic never waits for another PASS, while final validation needs matching actual evidence throughout the required scope.

```sh
ccdd-project config check
ccdd-project status
ccdd-project plan implementation --recursive
ccdd-project verify implementation --recursive --wait
ccdd-project verify --critic implementation/tests --wait
ccdd-project run show RUN_ID
```

Individual verification preserves selected results and reports missing other required evidence as INCOMPLETE. `--recursive` includes that evidence's Critics. `--force` reevaluates selected Critics. Matching actual PASS is reused; no stale state is persisted. Queries execute no scripts and create no tickets or stores.

State defaults to `~/.local/state/ccdd/<workspace-path-hash>`, configurable with `--state-dir` or `CCDD_STATE_HOME`. State and all output must remain outside reviewed input. Reviews use the unchanged supplied workspace directly through execution and Human waiting. Users may provide a separate worktree with `--repo`.

With `--wait`: 0=fulfilled, 1=RED, 2=ERROR, 3=timeout, 4=incomplete. Without waiting, inspect the returned Run status; acceptance is not completion. `request claim`, `request tool` and `request submit` perform explicit local Human actions. `doctor`, `tools check` and `monitor` are supported.

`ccdd` exposes the same commands. There is no legacy run/config/group/generated compatibility path. Historical input versions are result-only, never reused or resumed. See the [repository guides](https://github.com/lhj6102/ccdd#readme).

## License

[MIT](LICENSE).
