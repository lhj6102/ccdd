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

## License

[MIT](LICENSE).
