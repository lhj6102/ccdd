import { readFile } from 'node:fs/promises';
import { defineConfig, defineTool } from '@ccdd/core';

// This factory defines a tool. It does not read the Artifact or execute an app.
function customTextReader() {
  return defineTool({
    metadata: {
      description: '{artifactName}의 지정한 줄 범위를 읽습니다.',
      inputSchema: {
        type: 'object',
        properties: {
          startLine: { type: 'integer', minimum: 1 },
          lineCount: { type: 'integer', minimum: 1, maximum: 80 },
        },
        required: ['startLine', 'lineCount'],
        additionalProperties: false,
      } as const,
      resultKinds: ['json'],
      observation: 'content',
      artifactKind: 'file',
    },
    async execute(context, args) {
      // Deliberately small teaching example: it accepts files up to 1 MiB.
      const file = await context.resolvePath();
      const bytes = await readFile(file, { signal: context.signal });
      if (bytes.length > 1024 * 1024) throw new Error('This example reader supports files up to 1 MiB.');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (text.includes('\0')) throw new Error('This example reader accepts text, not binary data.');
      const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      const offset = args.startLine - 1;
      const selected = lines.slice(offset, offset + args.lineCount);
      const content = selected.join('');
      if (Buffer.byteLength(content) > 64 * 1024) throw new Error('Select a smaller line range.');
      const nextOffset = offset + selected.length;
      return {
        content: [{ type: 'json', data: {
          content,
          startLine: args.startLine,
          endLine: selected.length ? nextOffset : null,
          lineCount: selected.length,
          totalLines: lines.length,
          nextStartLine: nextOffset < lines.length ? nextOffset + 1 : null,
        } }],
        ...(selected.length ? { observation: { kind: 'content' as const } }
          : lines.length === 0 ? { observation: { kind: 'empty' as const } } : {}),
      };
    },
  });
}

export default defineConfig(() => ({
  artifactTypes: {
    document: { agentTools: { read: customTextReader() } },
  },
  artifacts: {
    why: { type: 'document', path: 'why.md', basis: true },
    spec: { type: 'document', path: 'spec.md' },
  },
  critics: [{
    id: 'spec-why', title: 'Spec이 Why에 부합하는가', target: 'spec', deps: ['why'],
    profile: { kind: 'agent', provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'medium' },
    payload: { instruction: '두 문서를 읽고 Spec이 Why의 최대 개수 조건을 충족하는지 평가하세요.' },
  }],
}));
