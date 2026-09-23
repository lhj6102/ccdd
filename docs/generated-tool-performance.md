# Generated Artifact tool overhead

Issue [#32](https://github.com/lhj6102/ccdd/issues/32) identified repeated payload
transport, content hashing and copying on every generated-data tool invocation.
The registry now verifies and registers each captured Artifact once with its
private host. Later calls send the bound ID and arguments. The host retains a
private copy; each requested `readData()` still returns a fresh clone. A new host
validates its own captured inputs again, including changed data under the same ID.

## Constant-return benchmark

Environment: Node 22.22.0, Linux x64, Intel Core i5-9400F @ 2.90 GHz, six CPUs.
The baseline is v3.3.0 commit `731856a0b161659f27c49bd1bf651adf1c526e53`.
Both implementations use **content integrity**, sequential calls and one host at
a time. Three pairs alternate baseline/candidate, candidate/baseline, then
baseline/candidate. The table reports the median of each trial's warm median.
No model or Provider is called and no verdict is produced.

Each fixture contains generated JSON objects of the stated serialized size. One
tool returns `{ok: true}` without reading data; the other reads the captured data
and returns the same constant. Each trial warms up 20 calls per tool and measures
200 calls per tool, alternating tools. The actual Artifact Runner, IPC host and
result validation execute. Fixture creation and inspection are outside tool time.

| JSON bytes | Tool | v3.3.0 | Candidate | Reduction |
| ---: | --- | ---: | ---: | ---: |
| 12,882 | Constant, no data read | 2.62 ms | 1.19 ms | 54% |
| 12,882 | Constant after readData | 2.90 ms | 1.51 ms | 48% |
| 65,682 | Constant, no data read | 8.31 ms | 1.23 ms | 85% |
| 65,682 | Constant after readData | 9.63 ms | 2.69 ms | 72% |

For 65,682-byte inputs, outbound execution messages fell from 66,296 to 285 bytes
per call, a 99.6% reduction. The full payload instead crosses once at registration.
Transport counting uses a separate 20-call pass after timing, so the extra
`JSON.stringify()` used for byte measurement does not inflate timed calls.
These byte counts exclude the transport's own framing and return messages.

Registry/host setup is reported separately. Median setup changed from 258 to
261 ms for the smaller input and 262 to 274 ms for the larger input. Registration
moves one content check/copy and IPC exchange into this setup; it is not free.
`readData()` remains proportional to the requested data's size because its clone
preserves mutation isolation. Constant-return calls no longer scale with that size.

Inspection uses the existing lock-mode workspace path, followed by a registry
opened directly on the source workspace. There is no workspace copy in tool-call
time. This does not compare complete Broker lock/copy workflows or change either
workspace integrity policy. See [workspace overhead](performance.md) for that
separate benchmark and its policy/platform qualifications.

## Application confirmation

The lostbuilds evaluation tools were replayed offline for skill 305:34060: base
and all 30 cumulative tripod prefixes. Each state received seven tools at three
numerical conditions, repeated three times: 1,953 calls per implementation.
The application-side numerical cache was enabled on both sides; only CCDD changed.

| Measurement | v3.3.0 | Candidate |
| --- | ---: | ---: |
| Total tool-call wall time | 9.40 s | 3.89 s |
| Total host setup, 31 hosts | 9.23 s | 9.20 s |
| Changed normalized observations | — | 0 / 1,953 |

This paired application run reduced tool-call wall time by 58.6%. It is a single
matrix comparison, separate from the three synthetic pairs. Description wrappers
retain the same logical paths; hashes compare the query data against the direct
implementation. It does not measure model inference, rate limits, original-run
contention or complete review latency. Raw application observations and the
harness remain in the consuming repository; the aggregate is included here.

## Reproduce

Build each revision with Node 22 LTS and `npm ci && npm run build`. From the
candidate checkout, use the same driver for both revisions:

```sh
node scripts/benchmark-generated-tools.mjs --implementation /path/to/baseline/dist --output /tmp/baseline.json
node scripts/benchmark-generated-tools.mjs --implementation dist --output /tmp/candidate.json
```

The implementation path must belong to a complete built checkout, with its
package metadata and dependencies resolvable. Alternate order for subsequent
pairs. The driver also accepts `--samples N`; the recorded results use its default
200. It creates and deletes its own temporary input/output directories. No
absolute latency threshold is imposed in the test suite.

[Summary and environment](benchmarks/generated-tools/summary.json) ·
[Application aggregate](benchmarks/generated-tools/application-summary.json) ·
[Baseline trials](benchmarks/generated-tools/baseline-1.json) ·
[Candidate trials](benchmarks/generated-tools/candidate-1.json)

All six trial files include the per-call timings, separate inspection/setup times,
registration traffic and execution traffic. Tests exercise the real registry and
host seam: repeated/concurrent observations, independent `readData()` results,
caller-owned input/result edits, fresh snapshots under the same ID, corrupted or
missing saved material, Broker restart, Agent, MCP and local Human access.
