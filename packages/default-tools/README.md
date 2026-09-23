# @ccdd/default-tools

Optional common view scripts for CCDD 4. Use Node 22 LTS, at least 22.19.0. Install `@ccdd/core@^4`, `@ccdd/project@^4` and `@ccdd/default-tools@^4`. Installation and imports register no tools.

Declare each view explicitly in the owning folder's `ccdd.json`:

```json
{
  "name": "document",
  "basis": true,
  "views": {
    "agentTools": {
      "read": {
        "metadata": {
          "description": "Read UTF-8 lines from {artifactName}.",
          "inputSchema": {
            "type": "object",
            "properties": { "path": { "type": "string" }, "startLine": { "type": "integer", "minimum": 1 }, "lineCount": { "type": "integer", "minimum": 1, "maximum": 500 } },
            "required": ["path"],
            "additionalProperties": false
          },
          "resultKinds": ["json"],
          "observation": "content",
          "executionPaths": ["node_modules/@ccdd/default-tools/dist", "node_modules/@ccdd/core/dist"]
        },
        "script": { "command": "ccdd-view", "args": ["read"] }
      }
    }
  }
}
```

The shared execution paths are relative to the workspace root. Install dependencies there before evaluation. The runner resolves the nearest installed `ccdd-view` executable and supplies the standard version 1 JSON request on stdin. Stdout is a ToolResult. See the [complete JSON example](examples/document/ccdd.json).

| Fixed operation | Reviewer arguments | Result |
| --- | --- | --- |
| `read` | `path`, optional `startLine`, `lineCount` | UTF-8 line data; default 80, maximum 500 lines. |
| `list` | optional `path`, `offset`, `limit` | Directory entries and logical mounts; maximum 200 entries. |
| `image` | `path` | Native PNG/JPEG/WebP image block. |
| `open` | optional `path` | Desktop launch receipt. |

Paths are logical paths inside the bound Artifact and may pass through children or mounts. They resolve to existing canonical paths before reading or launching. No mount folder, symlink or workspace copy is created. Invalid paths, symlink file traversal and unsupported files fail explicitly.

Reads preserve UTF-8 and LF/CRLF, return complete lines and cap text at 64 KiB. Invalid UTF-8, binary content and oversized individual lines fail. Content reads and truly empty files count as observations; listings and reads beyond EOF do not. Images use the existing packaged Pi read adapter without a Provider call, and validate actual bytes, format and the 4 MiB limit. GIF/BMP/animated PNG are rejected, with no automatic conversion.

Register a Human tool with `"script":{"command":"ccdd-view","args":["open"]}` and `resultKinds:["launch"]`, `observation:"none"`. The default desktop opener uses macOS. Other platforms can provide fixed launcher options as a JSON argv value:

```json
{"command":"ccdd-view","args":["open","{\"command\":\"/usr/bin/xdg-open\",\"args\":[\"{artifactPath}\"]}"]}
```

The options are configuration, never reviewer arguments. A successful launch does not prove the person observed content or complete a review. Applications must not write into the workspace. Human review remains local, with a live monitoring worker.

The package also retains optional script-author helpers such as `agent.text.read()`, `agent.files.read()`, `agent.image.view()`, `human.desktop.open()` and `human.project.open()`. They return metadata/execute contracts that a user script may wrap; they are not configuration registration APIs. Core's `defineTool` is likewise an optional authoring/type helper. CCDD never imports those functions during discovery.

```sh
ccdd-project tools check --artifact document --for agent --tool read --execute --args '{"path":"notes.md"}'
```

## License

[MIT](LICENSE).
