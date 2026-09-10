# CCDD default tools

CCDD 3.1.1 supports Node.js 22 LTS (22.19.0 or later). Install published versions with `npm install --ignore-scripts @ccdd/core @ccdd/default-tools`. Install `@ccdd/project` as well to use the project CLI.

Optional tool implementations for `@ccdd/core`. This library does not register tools automatically. Import a factory and explicitly put its returned definition in your repository's `ccdd.config.ts`:

```ts
import { defineConfig } from '@ccdd/core';
import { agent, human } from '@ccdd/default-tools';

export default defineConfig(() => ({
  artifactTypes: {
    markdown: {
      agentTools: { read: agent.text.read() },
      humanTools: { open: human.desktop.open() },
    },
    code: {
      agentTools: { list: agent.files.list(), read: agent.files.read() },
      humanTools: { open: human.desktop.open() },
    },
  },
  artifacts: {
    why: { type: 'markdown', path: 'why.md', basis: true },
    spec: { type: 'markdown', path: 'spec.md' },
  },
  critics: [{
    id: 'spec-matches-why', title: 'Spec matches Why', target: 'spec', deps: ['why'],
    profile: { kind: 'agent', provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'medium' },
    payload: { instruction: 'Read both Artifacts and evaluate whether Spec satisfies Why.' },
  }],
}));
```

Factories perform no I/O. Each returns `{ metadata, execute, preflight }`; CCDD connects its Artifact and validates call arguments before execution. Descriptions may contain `{artifactName}`. `description` and `timeoutMs` can be supplied to every factory.

- `agent.text.read()` reads a file Artifact. Arguments: optional `startLine` (default 1), `lineCount` (default 80, maximum 500).
- `agent.files.read()` reads a file inside a directory Artifact; additionally requires an internal `path`.
- `agent.files.list()` lists a directory Artifact or internal `path`; optional `offset` and `limit` (maximum 200).
- `agent.image.view()` returns an actual image block from a file Artifact (`{}`) or an internal file in a directory Artifact (`{path: 'frames/preview.png'}`). Register it with the key `view_image`.
- `human.desktop.open()` opens a file or folder with macOS's default application. A directory Artifact accepts an optional internal `path`. Other platforms require an explicit `command`.

Agent tools invoke a packaged Node CLI directly, without a shell or a global executable installation. Reads preserve UTF-8 and LF/CRLF, return complete lines, and bound returned text to 64 KiB. Results contain paging information. Invalid UTF-8, binary content, oversized individual lines, symlinks and paths outside the Artifact fail explicitly. Only returned text or a truly empty file counts as content observation; listing and reading beyond EOF do not.

## Images

`agent.image.view()` is included in v1.1.0. The [image and group example](../../examples/artifact-groups/README.md) includes GitHub Release installation and tool verification instructions.

```ts
// Register this type in ccdd.config.ts.
image: {
  agentTools: { view_image: agent.image.view() },
  humanTools: { open: human.desktop.open() },
}
```

A `preview` Artifact of this type exposes `view_image_preview` to Agents and `open_preview` to Humans. The image CLI reuses Pi Agent Core 0.85.1's `createReadTool()` with a filesystem adapter exposing only the bound file. It makes no LLM call, starts no Agent session and provides no general filesystem or shell access. The package pins this Pi dependency directly; Pi types are not exposed through the public CCDD tool definition.

Image contents, rather than filename extensions, determine support. A successful result requires a PNG/JPEG/WebP image block of at most 4MiB and produces a content observation for that leaf. Text-only results, GIF, BMP and animated PNG are rejected. No image processor is installed: the tool does not resize or convert unsupported input. Preflight checks availability and shape without rendering; use `--execute` to verify the actual image result. Agent reviews need a model supporting image input.

```sh
ccdd tools check --artifact preview --for agent --tool view_image --execute
ccdd tools check --artifact frames --for agent --tool view_image --execute --args '{"path":"preview.png"}'
```

Artifact groups are configured in the core as `{kind:'group',members:[ID,...]}`. Tools stay registered on individual Artifact types, and shared leaf members receive one tool binding per operation. `tools check --artifact GROUP` preflights the member tools; execution explicitly selects a leaf.

## Desktop opening

Human tools launch a desktop program and return a launch receipt, never decoded file contents. A successful launcher exit does not prove the person read the file and does not complete a review. Input snapshots are managed and retained by CCDD. Launchers should return after opening the application; avoid a wait-for-editor-exit flag. Preparation checks executable availability without launching the application.

```ts
human.desktop.open({ app: 'TextEdit' }); // macOS
human.desktop.open({ command: '/path/to/viewer', args: ['--read-only', '{artifactPath}'] });
```

`args` are fixed repository configuration and require a standalone `{artifactPath}` token; without `args`, an explicit command receives the Artifact path as its only argument. Reviewers cannot supply a command, argv or environment. The process receives only a small desktop environment allowlist, excluding Provider secrets and `NODE_OPTIONS`. CCDD configuration and custom executables are trusted repository code, not an OS sandbox.

The package contains no runtime import from CCDD and owns no Broker state. Its peer dependency supplies only the shared public tool contract; custom tools may implement that same contract without installing this library.

## Bundled project applications

`human.project.open({ runtime: 'tools/blender', executable: 'blender' })` opens an
Artifact with a portable application included in the project. `runtime` is a
project-relative directory and `executable` is relative to it. Optional fixed
`args` must include `{artifactPath}`; the default passes the Artifact path alone.
The complete runtime directory participates in the tool's input identity, including
supported internal relative symlinks. Reviewers cannot choose a different program.

The actual application is launched with isolated writable home/config/cache
directories in the review output. After successful process launch and the brief
startup handoff, the reviewer owns the desktop session; it remains open after the
tool host exits. A launch receipt does not prove rendered content or review
completion. The immutable input copy remains available for the application.

Use project `envRequirements` for external prerequisites that cannot be bundled.
See [remote Human review](../../docs/remote-human-review.md) for the full workflow.

## License

Licensed under the [MIT License](LICENSE).
