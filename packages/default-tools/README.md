# CCDD default tools

Optional tool implementations for `@lhj6102/ccdd`. This library does not register tools automatically. Import a factory and explicitly put its returned definition in your repository's `ccdd.config.ts`:

```ts
import { defineConfig } from '@lhj6102/ccdd';
import { agent, human } from '@lhj6102/ccdd-default-tools';

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
- `human.desktop.open()` opens a file or folder with macOS's default application. A directory Artifact accepts an optional internal `path`. Other platforms require an explicit `command`.

Agent tools invoke a packaged Node CLI directly, without a shell or a global executable installation. Reads preserve UTF-8 and LF/CRLF, return complete lines, and bound returned text to 64 KiB. Results contain paging information. Invalid UTF-8, binary content, oversized individual lines, symlinks and paths outside the Artifact fail explicitly. Only returned text or a truly empty file counts as content observation; listing and reading beyond EOF do not.

Human tools launch a desktop program and return a launch receipt, never decoded file contents. A successful launcher exit does not prove the person read the file and does not complete a review. Input snapshots are managed and retained by CCDD. Launchers should return after opening the application; avoid a wait-for-editor-exit flag. Preparation checks executable availability without launching the application.

```ts
human.desktop.open({ app: 'TextEdit' }); // macOS
human.desktop.open({ command: '/path/to/viewer', args: ['--read-only', '{artifactPath}'] });
```

`args` are fixed repository configuration and require a standalone `{artifactPath}` token; without `args`, an explicit command receives the Artifact path as its only argument. Reviewers cannot supply a command, argv or environment. The process receives only a small desktop environment allowlist, excluding Provider secrets and `NODE_OPTIONS`. CCDD configuration and custom executables are trusted repository code, not an OS sandbox.

The package contains no runtime import from CCDD. Its peer dependency supplies only the shared public tool contract; custom tools may implement that same contract without installing this library.
