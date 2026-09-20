# Review overhead benchmark

The CLI benchmark measures CCDD preparation and result handling separately from
the instrumented custom Artifact operation. It runs actual CLI commands and
detached workers against a synthetic Human-review fixture. Fixture verdicts are
controlled test data, not real Human review evidence.

## Original Windows results

Measured on Windows x64, Node 22.22.0 and an Intel Core i5-9400F on 2026-09-17.
The baseline is `ef643ca343c3af152d706f30d7c4f045922cc852` (v3.1.2 main).
The candidate is the original PR #27 implementation at
`e34b4c82b483d5301992016ef9d3a05f047de793`, before integration with v3.2.0
and the subsequent publication optimization described below.
The fixture contains 16,000 one-KiB files, a 64-MiB binary, a small configuration
and a custom Artifact file. One warm-up per implementation is discarded; three
measured pairs alternate execution order. No other tests or builds ran during
the timed comparisons.

**The baseline uses content integrity; the candidate explicitly selects metadata
integrity. These policies have different guarantees.** The default remains
content integrity. Metadata mode hashes bytes at initial capture, then relies on
complete metadata and structure checks at later boundaries. It assumes trustworthy
filesystem metadata, and its evidence cannot satisfy a content-policy query.
See the [integrity contract](contracts.md#optional-metadata-integrity).

| Workflow | Baseline median | Candidate median | Time remaining | Speedup | Below 10% |
| --- | ---: | ---: | ---: | ---: | --- |
| Lock | 152.96 s | 14.54 s | 9.50% | 10.52x | Yes |
| Fresh copy | 225.65 s | 38.32 s | 16.98% | 5.89x | No |

The less-than-10% target applies to the complete measured workflow, not to every
phase. It is met only for this synthetic lock workflow with explicit metadata
integrity. These results do not establish the same speedup for default content
integrity, other file layouts, filesystems, or actual game reviews.

| Phase | Lock baseline / candidate | Copy baseline / candidate |
| --- | ---: | ---: |
| Admission, input capture and worker startup | 23.62 / 5.64 s | 105.23 / 28.74 s |
| Accepted request to notification readiness | 31.15 / 2.14 s | 30.86 / 2.29 s |
| Claim and environment/tool preparation | 35.78 / 2.68 s | 33.79 / 2.98 s |
| Tool response excluding custom read | 35.82 / 2.69 s | 31.58 / 2.77 s |
| Result submission and return | 24.34 / 1.35 s | 23.51 / 1.39 s |
| Result return to worker exit | 71.8 / 77.0 ms | 1.9 / 1.8 ms |

Independent phase medians do not sum to the median total. Copy workers can pause
and exit after notification, before result submission; their earlier work remains
inside the measurement. The harness waits for every observed worker to exit
before the next attempt.

Lock paired remaining ratios: 9.72%, 9.37%, 9.52%. Candidate totals ranged from
14.33 to 14.98 s. Copy paired ratios: 17.01%, 16.68%, 15.18%; candidate totals
ranged from 34.10 to 38.38 s. Raw samples, timeouts and exact medians are in the
[lock report](benchmarks/review-overhead-lock.windows.json) and
[copy report](benchmarks/review-overhead-copy.windows.json).

## Additional publication optimization on Linux

Measured on Linux with Node 22.22.0 on 2026-09-20, using the same 16,000-file and
64-MiB fixture. The baseline is the original PR integrated with v3.2.0 at
`7eb9d636c314d4aae080193d87820c98d4a00d74`; the candidate is
`fd712c5fccb4f2040216eba5676160879313660b`. Both source trees were clean and built
before measurement. No tests or builds ran concurrently. Each implementation
had one discarded warm-up, and every attempt used a fresh CCDD copy cache.

Unlike the original Windows comparison, each Linux comparison uses the same
integrity policy on both sides. These measurements isolate the additional
publication changes; they do not compare against the original v3.1.2 baseline.

| Fresh-copy policy | Measured pairs | Baseline framework time | Candidate framework time | Reduction |
| --- | ---: | ---: | ---: | ---: |
| Metadata | 3, alternating order | 43.20 s median | 37.55 s median | 13.09% |
| Content | 1 | 92.71 s | 90.67 s | 2.20% |

Metadata admission medians fell from 27.44 s to 21.64 s, a 21.14% reduction.
Paired framework-time reductions were 13.37%, 13.09% and 12.93%. The content run
is a single-pair sanity check, not evidence of a general default-policy speedup.
The full published-byte check remains in content mode. Cache-hit tests verify
that both policies now perform one published-byte traversal instead of two;
these fresh-copy measurements do not establish an end-to-end cache-hit speedup.

Exact source revisions, policy selection, raw samples and medians are in the
[metadata report](benchmarks/copy-publication-metadata.linux.json) and
[content report](benchmarks/copy-publication-content.linux.json). Their remaining
ratios compare against the integrated original PR, so they cannot determine
whether the original Windows target is met. That target remains open.

## Measurement scope

- Include every CLI startup, request admission, input validation/copying,
  detached worker startup, notification readiness, Claim preparation, tool
  response, result submission and worker settlement.
- Subtract only the instrumented custom file-read body. Trivial custom result
  construction remains in the measured overhead.
- Exclude fixture creation/deletion, dependency installation, Human think time,
  HTTP transport and GUI rendering.
- Use a unique external state directory per attempt. Every copy attempt starts
  with an empty CCDD copy cache, so initial copying and publication are included.
  The OS file cache is not flushed; this is not a cold-disk measurement.

The harness verifies persisted integrity policy and worker identities. It retains
private fixtures if cleanup cannot be proven. All recorded runs completed all
attempts and removed their private fixtures successfully.

## Reproduce

Use Node 22 LTS and build the baseline and this checkout separately. From this
checkout, in PowerShell:

```powershell
git worktree add --detach ../ccdd-baseline ef643ca343c3af152d706f30d7c4f045922cc852
Push-Location ../ccdd-baseline
npm ci
npm run build
Pop-Location
npm ci
npm run build

$env:BENCH_FILES = '16000'
$env:BENCH_ROUNDS = '3'
$env:BENCH_INTEGRITY = 'metadata'
foreach ($mode in @('lock', 'copy')) {
  $env:BENCH_MODE = $mode
  $env:BENCH_REPORT_FILE = "../review-overhead-$mode.json"
  node scripts/benchmark-cli-review.mjs ../ccdd-baseline .
}
```

Use `BENCH_INTEGRITY=content` for a comparison that keeps both policies at content
integrity. Do not apply the recorded metadata-mode speedup to that comparison.
`BENCH_BASELINE_INTEGRITY` defaults to `content`. Set it to `metadata` only when
the baseline already supports that policy and both sides should use it.
Smaller `BENCH_FILES` and `BENCH_ROUNDS` values can check functionality, but their
timings are not directly comparable to the recorded fixture.

To reproduce the additional Linux metadata comparison, build the integrated
baseline separately and run the current harness from this built checkout:

```sh
git worktree add --detach ../ccdd-integrated-baseline 7eb9d636c314d4aae080193d87820c98d4a00d74
(cd ../ccdd-integrated-baseline && npm ci && npm run build)
BENCH_FILES=16000 BENCH_ROUNDS=3 BENCH_MODE=copy \
BENCH_BASELINE_INTEGRITY=metadata BENCH_INTEGRITY=metadata \
BENCH_REPORT_FILE=../copy-publication-metadata.linux.json \
node scripts/benchmark-cli-review.mjs ../ccdd-integrated-baseline .
```

Set both integrity variables to `content` and `BENCH_ROUNDS=1` for the recorded
content sanity check. Use more alternating pairs for conclusions about a small
timing difference. The committed candidate revision above reproduces the
measured implementation; subsequent documentation changes do not alter it.

## Remaining copy work

The measured copy target is below 22.57 s, requiring about 41.12% less time than
the original candidate median. Admission alone takes 28.74 s, so optimizing only
the later CLI phases cannot meet that target.

The original fresh metadata-mode copying performed three
full content traversals: source capture, staged-copy validation and published-copy
observer initialization, in addition to the copy itself. Metadata traversals and
read-only sealing also remain. The benchmark does not attribute separate timings
to these internal operations.

The integrated implementation can carry the staged proof across publication in
metadata mode, eliminating the third content traversal when directory identity,
structure and entry metadata still match. It allows only the root ctime change
from rename; unexpected changes trigger full byte validation. Content mode keeps
its full published-byte check. Cache hits under either policy now validate bytes
once with the retained observer. See the [publication contract](contracts.md#workspace-contract).

The current optimization stays within existing workspace acquisition and
observation. Combining source hashing with copying is deferred because it would
require broader changes to cache selection, source-change detection, publication
locking and cancellation. The original Windows target remains open until the
updated implementation is measured on that fixture.
