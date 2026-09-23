# Requester contract

The public CLI is `ccdd-project`, with `ccdd` as the same command interface. A Requester selects an Artifact, a qualified Critic or all Artifacts, and supplies an unchanged workspace. Configuration is discovered from regular per-folder `ccdd.json` files; arbitrary request envelopes and global config factories are not public admission APIs.

A programmatic caller can use `inspectProject`, `createBroker` and `createExecutorRegistry` from `@ccdd/project`:

```js
import { createBroker, createExecutorRegistry } from '@ccdd/project';
const broker = createBroker({ repoPath: '/workspace', stateDir: '/external/state', repoId: 'local', executors: createExecutorRegistry() });
try {
  const run = await broker.submitProject({ selection: { kind: 'artifact', artifactId: 'implementation' }, recursive: true });
  const completed = await broker.run(run.id);
  console.log(completed.status);
} finally {
  await broker.close();
}
```

Provider authentication and Human alarm registration must be supplied when those profiles are used. `submitProject` records immutable static manifests and input identities without evaluating. `run` owns actual execution; CLI workers run independently of the initial command. No fabricated semantic results or dependency tickets are admitted.

The internal envelope contains the owner target, resolved instruction dependencies, alias bindings, admitted child/mount closure, required content observations, profile, payload, workspace proof and serializable config manifest. Script implementations reconnect only from matching static declarations. Results remain tied to that input; later edits do not reinterpret completed Runs.

Dependencies do not delay a ready selected Critic. Final satisfaction is checked across the complete required closure and may be INCOMPLETE even with a selected GREEN result. Historical input versions support result lookup only. See [contracts](contracts.md) and [command options](project-validation.md).
