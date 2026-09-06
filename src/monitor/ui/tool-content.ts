export type DisplayToolContent = { type: 'text' | 'json'; text: string } | { type: 'image'; src: string } | { type: 'launch' } | { type: 'unsupported' };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Images must arrive as validated inline bytes from the Runner, never as arbitrary filesystem URLs. */
export function toolContent(result: unknown): DisplayToolContent[] | null {
  if (!record(result) || !Array.isArray(result.content)) return null;
  return result.content.map((item): DisplayToolContent => {
    if (!record(item)) return { type: 'unsupported' };
    if (item.type === 'text' && typeof item.text === 'string') return { type: 'text', text: item.text };
    if (item.type === 'json' && Object.hasOwn(item, 'data')) return { type: 'json', text: JSON.stringify(item.data, null, 2) ?? 'null' };
    if (item.type === 'launch' && item.launched === true) return { type: 'launch' };
    if (item.type === 'image' && ['image/png', 'image/jpeg', 'image/webp'].includes(String(item.mimeType)) && typeof item.data === 'string'
      && item.data.length > 0 && item.data.length <= 5_592_408 && item.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(item.data)) {
      return { type: 'image', src: `data:${item.mimeType};base64,${item.data}` };
    }
    return { type: 'unsupported' };
  });
}
