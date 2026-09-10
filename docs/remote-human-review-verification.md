# Remote Human review verification

Verified on Linux x86_64 with Node.js 24.18.0.

- Base: latest `origin/main`, `12bf0d089d3f207b2f230d92a8b010b0cc89cf11`,
  fetched again after implementation with no intervening main changes.
- Reviewed implementation: `779f29ffad950574ccc90acf232faac17ece2a8e`.
- Branch: `codex/remote-human-review`.

## Checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed, including the Vue frontend |
| `npm test` | 360 passed, 0 failed, 1 Windows-only test skipped |
| `npm run test:packages` | Passed for installed core + default tools and core + custom tools |
| `git diff --check` | Passed |

`npm test` includes the English-language check, complete build, and Node's built-in
test runner. Package verification built real tarballs, installed production
dependencies without install scripts, and performed actual tool and synthetic
Runtime execution from immutable copies. It did not publish packages.

The new integration tests exercise real HTTP transfers, cache reuse across
changed snapshots, actual local tool and check processes, central Human result
submission, Try Claim races and expiry, cancellation through both local CLIs,
actionable monitor errors, and read-only GET behavior. Controlled failure cases
cover corrupted inputs, traversal and symlinks, an idle download, and a lost
renewal response. These are test fixtures, not actual Provider or production Human
review evidence.

Bundled-viewer tests start real controlled executable processes and verify
desktop connection settings, private writable configuration, and survival after
tool-host closure. This verification did not render a production Blender project
or run on Windows/macOS.

## Independent reviews

The reviewing agents did not implement the code they reviewed.

- **Transfer review:** no remaining actionable findings after rechecking POSIX
  filename support and cancellation of idle streamed downloads.
- **Standards review:** clear at `779f29f`; no remaining actionable findings.
  Credential containment and historical saved-manifest compatibility were fixed
  and rechecked.
- **Spec review:** clear at `779f29f`; no remaining actionable findings. The reviewer
  independently reran the actual-process regressions for local CLI cancellation,
  cross-locale remote claims, and desktop environment propagation. The final
  stalled-renewal and historical-manifest changes were rechecked in source, and
  their dedicated regressions passed in the complete suite.

All eight actionable findings across these reviews were addressed: POSIX filename
rejection, idle-download cancellation, credential containment, desktop connection
variables, local CLI signal cleanup, locale-dependent module sorting, historical
manifest reconnection, and stalled renewal cleanup.

See [usage and supported scope](remote-human-review.md) and the
[implementation requirements](plans/remote-human-review.md).
