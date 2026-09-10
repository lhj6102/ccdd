# Contributing to CCDD

CCDD checks project materials through explicit Artifact, Critic, and tool definitions. Start with the [README](README.md), then read [the context map](CONTEXT-MAP.md) and [implementation contracts](docs/contracts.md) before changing how those pieces work together.

## Set up

Use Git and Node.js 22 LTS (22.19.0 or later). `.nvmrc` selects the Node 22 LTS line; use its latest patch for development.

```sh
npm ci
npm test
npm run test:packages
```

`npm test` checks repository language, builds the project, and runs Node's built-in test runner. The build includes TypeScript and UI type checking, so a separate `npm run typecheck` is unnecessary after a successful `npm test`. `npm run test:packages` uses that existing build to install the real tarballs and exercise both default-tool and custom-tool configurations. They may need the npm registry or a populated local cache.

CI runs once per push to main in one Node 22 LTS job. It installs dependencies, runs `npm test`, verifies the packed production installations, and retains the verified packages for 14 days. Pull requests and release tags do not repeat the tests. CD publishes those exact CI packages without installing project dependencies, rebuilding, or running tests. Run local checks with Node 22 LTS, selected by `.nvmrc`. Node 22.19.0 is the minimum required by the Pi libraries; CCDD also uses native SQLite, TypeScript loading, and synchronous module hooks. Other Node major versions are unsupported. Node 22 support starts with CCDD 3.1.0; older packages retain their original Node requirement.

## Language and examples

Write documentation, comments, CLI and monitor messages, review prompts, example content, and test descriptions in English. Keep the public terms Artifact, Critic, Project Validation, Broker, and Executors consistent with the context documents.

Run `npm run check:language` to catch literal Hangul left in maintained text files. This is a mechanical regression check, not a natural-language classifier. For tests that need non-English bytes, use explicit Unicode escapes and explain the encoding behavior in English. Keep coverage for UTF-8, byte limits, line boundaries, and CRLF intact. CCDD continues to support Unicode project materials.

Keep the main README approachable. Put detailed command options and execution contracts in the linked guides. The main diagram shows project-defined Artifact relationships on the left, CCDD in the middle, and reviewers on the right; distinguish configuration from execution by both color and line style.

## Changes and verification

- Preserve the separation between definitions, project validation, review lifecycle, and execution.
- Register tools explicitly. Keep credentials, stored review state, and generated output outside reviewed inputs.
- Exercise real runtime and tool behavior. Never replace actual Provider or Human reviews with fabricated recorded verdicts.
- Use Node's built-in test runner. Test through seams used by callers: Project queries, Broker requests, tool/Provider adapters, files, SQLite, processes, HTTP, rendered UI, and installed packages.
- Keep one owner for each contract. Remove internal helper/output-shape checks and repeated scenarios already covered at that seam; preserve distinct failure modes, encoding, and isolation contracts. Run the affected tests after changes, then the complete suite once.
- Describe the problem, the resulting behavior, and the validation in your pull request.

Test fixtures may use controlled transports for deterministic tests. Distinguish those fixtures from actual Provider evaluations and release verification evidence.

## Releases

Follow [the release guide](docs/releases.md). Building, testing, or opening a pull request does not publish packages or change repository visibility. Pushing a version tag starts the single Node 22 LTS release job, which uses npm Trusted Publishing.
