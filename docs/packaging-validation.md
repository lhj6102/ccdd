> Historical verification of v0.1/v0.2. This file describes the previous commit/server demo; use README.md and contracts.md for v0.3.

# Package installation verification

Verified on 2026-09-05 with Node 24.19.0 and npm 10.1.0.

- Installed the tarball produced by `npm pack` into a separate temporary folder with `npm install <tarball> --omit=dev --ignore-scripts`. Three runtime packages were installed.
- The installed `ccdd help` and `ccdd prepare-demo` ran successfully.
- The installation included `public/index.html`, `public/app.js`, `public/styles.css`, and `scripts/prepare-demo.mjs`.
- The installed Codex resolved from the parent `node_modules/@openai/codex/bin/codex.js`, was executable, and reported `codex-cli 0.153.4`.
- Generated state, worktrees, authentication data, and recording output were excluded from the package.
- Nothing was published to npm. This verification did not request another actual Agent review.

## Snapshot reproducibility

All four commits matched between the demo repository created by the installed CLI and a newly generated demo repository in a separate location. The demo generator fixes commit dates, author, SHA-1 format, and disabled signing.

| Scenario | Commit |
| --- | --- |
| baseline | `530b86d335b4191900ea14e032b96d27a2d33a2e` |
| why-change | `9491804ac8f626a7137857b6e8376aa32130b2cc` |
| runtime-failure | `1764e57283520658a468dcf98c8df3f18746e360` |
| fixed | `b2dc464e26af160ffbef2b721336036f3a387884` |

These hashes correspond to this demo's Artifact and Critic definitions. Changing that content produces new hashes.
