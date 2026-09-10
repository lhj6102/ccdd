# Contributing to CCDD

CCDD checks project materials through explicit Artifact, Critic, and tool definitions. Start with the [README](README.md), then read [the context map](CONTEXT-MAP.md) and [implementation contracts](docs/contracts.md) before changing how those pieces work together.

## Set up

Use Git and Node.js 24 or later; `.nvmrc` records the supported Node major version.

```sh
npm ci
npm run typecheck
npm test
npm run test:packages
```

`npm test` checks repository language, builds the project, and runs Node's built-in test runner. Package checks install the real tarballs and exercise both default-tool and custom-tool configurations. They may need the npm registry or a populated local cache.

## Language and examples

Write documentation, comments, CLI and monitor messages, review prompts, example content, and test descriptions in English. Keep the public terms Artifact, Critic, Project Validation, Broker, and Executors consistent with the context documents.

Run `npm run check:language` to catch literal Hangul left in maintained text files. This is a mechanical regression check, not a natural-language classifier. For tests that need non-English bytes, use explicit Unicode escapes and explain the encoding behavior in English. Keep coverage for UTF-8, byte limits, line boundaries, and CRLF intact. CCDD continues to support Unicode project materials.

Keep the main README approachable. Put detailed command options and execution contracts in the linked guides. The main diagram shows project-defined Artifact relationships on the left, CCDD in the middle, and reviewers on the right; distinguish configuration from execution by both color and line style.

## Changes and verification

- Preserve the separation between definitions, project validation, review lifecycle, and execution.
- Register tools explicitly. Keep credentials, stored review state, and generated output outside reviewed inputs.
- Exercise real runtime and tool behavior. Never replace actual Provider or Human reviews with fabricated recorded verdicts.
- Use Node's built-in test runner and run checks appropriate to the affected behavior.
- Describe the problem, the resulting behavior, and the validation in your pull request.

Test fixtures may use controlled transports for deterministic tests. Distinguish those fixtures from actual Provider evaluations and release verification evidence.

## Releases

Follow [the release guide](docs/releases.md). Building, testing, or opening a pull request does not publish packages or change repository visibility. Publication is an explicit maintainer action.
