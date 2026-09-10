# @ccdd/project

CCDD's project validation tool. `@ccdd/core` provides definitions only; this package provides validation history, the CLI, Broker, Executors, and optional monitor. Default tools are available separately in `@ccdd/default-tools`.

CCDD 3.1.0 supports Node.js 22 LTS (22.19.0 or later). For versions published to npm, install with `npm install --ignore-scripts @ccdd/core @ccdd/project` and run `npx ccdd-project`. Also install `@ccdd/default-tools` if you use its tools.

```sh
ccdd-project status
ccdd-project plan implementation --recursive
ccdd-project verify implementation --recursive --wait
ccdd-project history implementation
ccdd-project run show RUN_ID
```

`verify ARTIFACT` requests only ready Critics and reports those with unmet prerequisites as incomplete. `--recursive` includes necessary predecessor validations. Selecting one Critic with `--critic ID` still checks prerequisites. Actual PASS evidence for identical input is reused by referencing the original verdict without creating a ticket. `--force` reviews selected Critics again.

No staleState is stored on Artifacts. SQLite records the target and direct dependency hashes and Critic conditions at verdict time; current validation is computed by recursively querying the DAG. `status` and `plan` create neither verdicts nor tickets. Temporary memoization exists only within a query.

State defaults to `~/.local/state/ccdd/<repo-path-hash>` and can be configured with `--state-dir` or `CCDD_STATE_HOME`. SQLite, input copies, and review output must stay outside the reviewed repo. Validation defaults to copy; explicit `--lock` selects monitoring of the original input.

`--json` returns structured results. `verify --wait` exit codes are 0=scope satisfied, 1=RED, 2=ERROR, 3=wait timeout, and 4=incomplete. For asynchronous execution, 0 means successful acceptance; a wait timeout does not cancel execution.

Handle Human reviews with `request claim`, `request tool`, and `request submit`. `doctor`, `tools check`, and `monitor` are also supported. See `ccdd-project help` for detailed options.

The existing `ccdd` command is included as a compatibility CLI in this execution package. Legacy `ccdd run --critic` retains its prerequisite bypass; use `ccdd-project verify` for the new project validation flow. Historical verdicts without recorded validation input hashes are not assumed to be reusable.

## License

Licensed under the [MIT License](LICENSE).
