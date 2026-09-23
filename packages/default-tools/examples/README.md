# Explicit registration

Copy `document/ccdd.json` into a real Artifact folder and adapt its name and Critic. Install the package at the workspace root. All paths in `metadata.executionPaths` are relative to that root. `ccdd-view` resolves from the nearest installed `node_modules/.bin`, then PATH. The caller supplies `path` to select a document or image inside this Artifact, a contained Artifact or a mount. Importing or installing the package registers no tools.
