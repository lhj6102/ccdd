# CCDD

Read docs/contracts.md and CONTEXT-MAP.md before changing boundaries.
One npm package; broker and executors are separate bounded contexts. Artifact Runner resolves request payload references into scoped viewer tools. Reviews use whole-workspace lock or immutable content-hash copies. Request-scoped workers own execution; the optional loopback monitor only observes persisted requests and scoped Artifacts. It never owns execution or reconciles stored state. Keep state and outputs outside reviewed input.
The demo graph is strictly linear: Why → Spec → Tests → Implementation. No multi-parent critic combinations.
Keep actual provider evaluation and runtime execution; never fabricate recorded review results. Use Node's built-in test runner. Do not commit authentication data, SQLite state, worktrees, or raw provider event logs.
