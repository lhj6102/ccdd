# CCDD

Install one package; its exact-version dependencies supply the separate CCDD modules:

```sh
npm install --ignore-scripts @ccdd/ccdd
# or
pnpm add --ignore-scripts @ccdd/ccdd
```

Use Node.js 22 LTS (22.19.0 or later). The public commands are `ccdd`,
`ccdd-project`, and `ccdd-view`; they forward the existing module entrypoints.
No install script, bundled monolith, or automatic tool registration is involved.

| Import | Public surface |
| --- | --- |
| `@ccdd/ccdd` or `@ccdd/ccdd/core` | Definitions and logical scope resolution |
| `@ccdd/ccdd/project` | Broker, executors, project queries and load checks |
| `@ccdd/ccdd/tools` | Common tool factories and `scriptRequest` |

Use these paths when only the umbrella is a direct dependency, including with
strict pnpm. Do not import undeclared transitive `@ccdd/*` packages from application
code. Advanced consumers may instead install the modules directly; default-tools
remains optional for those consumers.

See [getting started](https://github.com/lhj6102/ccdd/blob/main/docs/getting-started.md)
and [review management](https://github.com/lhj6102/ccdd/blob/main/docs/review-management.md).


### Existing Pi AI API

`@ccdd/ccdd/pi` re-exports Pi AI unchanged; `@ccdd/ccdd/pi/providers/all`
re-exports its public `builtinModels` and `builtinProviders` catalog API. These
are ESM and type forwards, not a new authentication manager or coding agent.
The umbrella declares Pi AI directly, so both paths work under strict pnpm.

The existing official CLI remains `npx @earendil-works/pi-ai@0.87.1 list` and
`npx @earendil-works/pi-ai@0.87.1 login [provider]`. Its current CLI lists/logs
in OAuth providers and saves `auth.json` in the current directory; use it only
from an appropriate private directory outside reviewed input. API-key login
is available through Pi's library API, not that OAuth-only CLI. These exports
do not create new CCDD login commands, persistence or credential precedence.

## License

[MIT](LICENSE).
