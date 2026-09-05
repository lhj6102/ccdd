import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxThinking, type Context, type Model, type SimpleStreamOptions, type ToolResultMessage } from '@earendil-works/pi-ai';
import type { StreamFn } from '../src/executors/pi.js';

export interface ArtifactStreamOptions {
  mode?: 'valid' | 'partial' | 'no-tools' | 'beyond-eof' | 'list-only' | 'malformed' | 'auth-error' | 'model-error' | 'network-error' | 'unknown-error' | 'throw' | 'hang' | 'wrong-nonce';
  result?: unknown;
  onRequest?: (input: { model: Model<string>; context: Context; options?: SimpleStreamOptions }) => void;
}

/** Scripted transport only; callers still run Pi's real Agent loop and CCDD's real tools. */
export function artifactStream({ mode = 'valid', result, onRequest }: ArtifactStreamOptions = {}): StreamFn {
  let faux: ReturnType<typeof fauxProvider> | undefined;
  return (model, context, options) => {
    onRequest?.({ model, context, options });
    if (mode === 'throw') throw new Error('opaque throw SECRET_TOKEN_NOT_FOR_OUTPUT');
    faux ??= fauxProvider({ provider: model.provider, api: model.api });
    faux.appendResponses([async () => {
      if (mode === 'hang') await new Promise<void>((_resolve, reject) => {
        if (options?.signal?.aborted) reject(new Error('aborted'));
        else options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      if (mode === 'auth-error') return fauxAssistantMessage('', { stopReason: 'error', errorMessage: '401 unauthorized SECRET_TOKEN_NOT_FOR_OUTPUT' });
      if (mode === 'model-error') return fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'model_not_found SECRET_TOKEN_NOT_FOR_OUTPUT' });
      if (mode === 'network-error') return fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'network fetch failed SECRET_TOKEN_NOT_FOR_OUTPUT' });
      if (mode === 'unknown-error') return fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'opaque failure SECRET_TOKEN_NOT_FOR_OUTPUT' });
      const seen = context.messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
      const has = (name: string) => seen.some(message => message.toolName === name);
      const calls = [];
      if (mode !== 'no-tools') {
        for (const tool of context.tools ?? []) {
          if (has(tool.name)) continue;
          if (tool.name.startsWith('list_')) {
            calls.push(fauxToolCall(tool.name, {}));
          } else if (mode !== 'list-only' && tool.name.startsWith('read_')) {
            let path: string | undefined;
            const required = (tool.parameters as { required?: unknown }).required;
            if (Array.isArray(required) && required.includes('path')) {
              const listed = seen.find(message => message.toolName === tool.name.replace(/^read_/, 'list_'));
              if (!listed) continue;
              const content = listed.content.find(block => block.type === 'text');
              const data = content?.type === 'text' ? JSON.parse(content.text) as { entries?: { kind: string; path: string }[] } : {};
              path = data.entries?.find(entry => entry.kind === 'file')?.path;
              if (!path) continue;
            }
            calls.push(fauxToolCall(tool.name, { ...(path ? { path } : {}), startLine: mode === 'beyond-eof' ? 1000 : mode === 'partial' ? 2 : 1, lineCount: mode === 'partial' ? 1 : 80 }));
          }
        }
      }
      if (calls.length) return fauxAssistantMessage([fauxThinking('PRIVATE_REASONING_DO_NOT_EXPOSE'), ...calls], { stopReason: 'toolUse' });
      const probe = seen.find(message => message.toolName.startsWith('read_ccdd_probe_'));
      if (probe) {
        const text = probe.content.find(block => block.type === 'text');
        const data = text?.type === 'text' ? JSON.parse(text.text) as { content: string } : { content: '' };
        return fauxAssistantMessage(JSON.stringify({ ready: true, nonce: mode === 'wrong-nonce' ? 'wrong' : data.content.trim() }));
      }
      return fauxAssistantMessage(mode === 'malformed' ? 'not json' : JSON.stringify(result ?? { verdict: 'GREEN', summary: '선언된 Artifact를 확인했습니다.', evidence: ['요청 Artifact의 실제 내용을 도구로 읽었습니다.'] }));
    }]);
    return faux.provider.streamSimple(model, context, options);
  };
}
