import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { TestContext } from 'node:test';
import type { ArtifactManifest, CriticDefinition, ArtifactViews, ScriptToolDefinition } from '../../src/sdk.js';
import { readWorkspaceConfig } from '../../src/broker/config.js';
import { prepareReviewRequests } from '../../src/requester/index.js';

export const agentProfile = { kind: 'agent', provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'medium', timeoutMs: 5000 } as const;
export const runtimeCritic = (id = 'check', instruction = 'Run the actual test.'): CriticDefinition => ({ id, title: `Check ${id}`, profile: { kind: 'runtime', command: 'node', args: ['--test', 'check.test.mjs'], timeoutMs: 5000 }, payload: { instruction } });
export const readTool = (): ScriptToolDefinition => ({
  metadata: { description: 'Read content from {artifactName} by line.', inputSchema: { type: 'object', properties: { startLine: { type: 'integer', minimum: 1 }, lineCount: { type: 'integer', minimum: 1, maximum: 500 } }, additionalProperties: false }, resultKinds: ['json'], observation: 'content' },
  script: { command: 'node', args: ['view.mjs'] },
});
export const fixtureViews = (): ArtifactViews => ({ agentTools: { read: readTool() }, humanTools: { read: readTool() } });
export const fixtureReader = `import { readerRequest } from ${JSON.stringify(new URL('../../packages/default-tools/dist/reader.js', import.meta.url).href.replace('/dist/test/helpers/', '/test/helpers/'))};
let text=''; for await (const chunk of process.stdin) text+=chunk;
const request=JSON.parse(text);
const data=await readerRequest({operation:'read',root:request.context.artifactPath+'/content.txt',directory:false,args:request.args});
process.stdout.write(JSON.stringify({content:[{type:'json',data}],...(data.lineCount>0?{observation:{kind:'content'}}:data.totalLines===0?{observation:{kind:'empty'}}:{})}));
`;
// Resolve the packaged fixture helper independently of source/build location.
export async function artifactFixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ccdd-artifact-'))), repoPath = join(root, 'repo'), stateDir = join(root, 'state');
  await mkdir(repoPath);
  const cleanups: (() => unknown | Promise<unknown>)[] = [];
  t.after(async () => { for (const close of cleanups.reverse()) await close(); await rm(root, { recursive: true, force: true }); });
  const cleanup = (close: () => unknown | Promise<unknown>) => { cleanups.push(close); };
  const manifests = new Map<string, ArtifactManifest>();
  async function write(folder: string, manifest: ArtifactManifest, files: Record<string, string | Buffer> = {}) {
    const directory = join(repoPath, folder); await mkdir(directory, { recursive: true });
    manifests.set(folder, structuredClone(manifest));
    await writeFile(join(directory, 'ccdd.json'), JSON.stringify(manifest, null, 2));
    const readerPath = resolve('packages/default-tools/dist/reader.js');
    for (const [name, content] of Object.entries({ 'content.txt': `Content of ${manifest.name}\n`, 'view.mjs': fixtureReader.replace(/from .*?;/, `from ${JSON.stringify('file://' + readerPath)};`), 'check.test.mjs': "import test from 'node:test'; import assert from 'node:assert/strict'; test('actual arithmetic',()=>assert.equal(2+2,4));\n", ...files })) {
      await mkdir(join(directory, name, '..'), { recursive: true }); await writeFile(join(directory, name), content);
    }
  }
  async function edit(folder: string, change: (manifest: ArtifactManifest) => void) {
    const manifest = structuredClone(manifests.get(folder)!); change(manifest); manifests.set(folder, manifest);
    await writeFile(join(repoPath, folder, 'ccdd.json'), JSON.stringify(manifest, null, 2));
  }
  return { root, repoPath, stateDir, write, edit, manifests, cleanup,
    config: async () => (await readWorkspaceConfig(repoPath)).config,
    requests: (criticId?: string) => prepareReviewRequests({ repoPath, repoId: 'fixture', snapshotHash: 'a'.repeat(64), criticId }),
  };
}
