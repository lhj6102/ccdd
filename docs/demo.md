# Linear folder Artifact demo

The demo keeps Why → Spec → Tests → Implementation. It creates four independent scenarios with per-folder `ccdd.json`, explicit script views, two Agent Critics and one Runtime Critic. Preparing the demo writes a new example workspace before evaluation; reviewing it never copies input.

Build and pack Core and optional default tools, then provide their absolute tarball paths. Preparation does not assume that version 4 is already published:

```sh
npm run build
mkdir -p /tmp/ccdd-demo-packages
npm pack --ignore-scripts --pack-destination /tmp/ccdd-demo-packages
npm pack --ignore-scripts --workspace @ccdd/default-tools --pack-destination /tmp/ccdd-demo-packages
export CCDD_DEMO_CORE_TARBALL=/tmp/ccdd-demo-packages/ccdd-core-4.0.0.tgz
export CCDD_DEMO_TOOLS_TARBALL=/tmp/ccdd-demo-packages/ccdd-default-tools-4.0.0.tgz
node dist/src/cli.js prepare-demo --demo-dir /tmp/ccdd-demo-v4
```

Use an empty directory. The default is `~/.local/share/ccdd/demo-v10`; 10 is the demo format version, separate from package version 4. Existing demos are preserved. Preparation installs dependencies once, then includes installed packages in each scenario before evaluation. Public transitive dependencies require the registry or a populated npm cache.

| Scenario | Intended difference |
| --- | --- |
| `baseline` | All stages agree on at most three tasks. |
| `why-change` | Why allows two tasks, while Spec still allows three. |
| `runtime-failure` | Spec and Tests allow two tasks; implementation allows three. |
| `fixed` | Every stage agrees on at most two tasks. |

Use ordinary workspace selectors; `--demo` and `--scenario` execution routes are removed:

```sh
node dist/src/cli.js config check --repo /tmp/ccdd-demo-v4/fixed
node dist/src/cli.js doctor --repo /tmp/ccdd-demo-v4/fixed --critic spec/matches-why
node dist/src/cli.js verify implementation --repo /tmp/ccdd-demo-v4/fixed --recursive --wait
node dist/src/cli.js run list --repo /tmp/ccdd-demo-v4/fixed
node dist/src/cli.js monitor --repo /tmp/ccdd-demo-v4/fixed
```

Agent commands use the requested Provider and consume its usage. Configure credentials outside the reviewed workspace; see [reviewers](reviewers.md). No Agent verdict is predetermined. To exercise only actual Runtime behavior, use `verify --critic implementation/passes-tests`; a passing test result can still yield final INCOMPLETE because Spec/Tests Agent evidence is absent.

Ready Critics can run concurrently despite the linear input relationships. The full result needs all required matching evidence. Changing a scenario creates new current input; recorded results remain tied to their original input. Registered Human views do not create Human reviews automatically.
