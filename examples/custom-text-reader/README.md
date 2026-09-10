# Custom Reader

This example directly registers `{ metadata, execute }` without the default tool library. `customTextReader()` creates a definition; actual file reading occurs when an Agent calls `read_spec` or `read_why`.

Each project must include its own dependencies. Copy this folder into a new project outside the repository, then install core and Project. The commands below work after npm v3.0.0 publication; before that, use the local tarballs described below. The example is included in the source repository and the core package's `examples/custom-text-reader`. It does not rely on CCDD installed in a parent repository.

```sh
# Copy the example from the CCDD source repository.
cp -R examples/custom-text-reader /tmp/ccdd-custom-reader
cd /tmp/ccdd-custom-reader
npm init -y
npm pkg set type=module
npm install --ignore-scripts @ccdd/core@3.0.0 @ccdd/project@3.0.0
npx ccdd tools check --artifact spec --for agent --tool read
npx ccdd tools check --artifact spec --for agent --tool read --execute --args '{"startLine":1,"lineCount":20}'
npx ccdd run --copy --critic spec-why --codex-auth-file "$HOME/.codex/auth.json" --wait
```

This example installs core and Project without the default tool library. Alternatively, in the source repository run `npm run release:npm -- --commit <40-character SHA> --dry-run` to verify and generate matching `ccdd-core-3.0.0.tgz` and `ccdd-project-3.0.0.tgz` files, then install with `npm install --ignore-scripts <core.tgz> <project.tgz>`. This local verification requires no GitHub authentication. If CCDD is already installed, change the first `cp` source to `node_modules/@ccdd/core/examples/custom-text-reader`.

The tool omits `preflight`. The default check distinguishes confirmed registration from unverified execution; `--execute` actually reads the file. Agent review requires valid Provider authentication.

This Reader is a small implementation illustrating the structure. It reads the file into memory before checking the 1MiB limit and limits returned text to 64KiB. A streaming reader is more appropriate for large files. It preserves UTF-8, CRLF, and the final newline, and distinguishes an empty file from a read past EOF. It returns an observation receipt only when actual content or an empty file was observed.

There is no Human duplicate of the Agent Reader. This type has no Human tools, so a Human Critic cannot use it. To add human viewing, write a custom tool that opens a desktop application or explicitly register `human.desktop.open()` from `@ccdd/default-tools`.
