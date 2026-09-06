export type InstructionPart = { type: 'text'; text: string } | { type: 'artifact'; artifactId: string };

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function escaped(source: string, index: number): boolean {
  let slashes = 0;
  while (index > 0 && source[--index] === '\\') slashes++;
  return slashes % 2 === 1;
}

/** Skip whole brace groups so JSON objects, doubled braces and nested expressions stay literal. */
function closingBrace(source: string, start: number): number {
  const literalOpening = escaped(source, start);
  let depth = 0, quote = '';
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (character === '\\') {
      // A literal \{...\} must end here rather than swallowing later references.
      if (!literalOpening || quote || (source[index + 1] !== '{' && source[index + 1] !== '}')) index++;
      continue;
    }
    if (quote) { if (character === quote) quote = ''; continue; }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '{') depth++;
    else if (character === '}' && --depth === 0) return index;
  }
  return -1;
}

/** Resolve only bare IDs already supplied to this request; never grant scope or evaluate code. */
export function parseArtifactInstruction(instruction: string, artifacts: readonly { id: string }[]): InstructionPart[] {
  const allowed = new Set(artifacts.map(artifact => artifact.id));
  const parts: InstructionPart[] = [];
  let textStart = 0, cursor = 0;
  while (cursor < instruction.length) {
    if (instruction[cursor] !== '{') { cursor++; continue; }
    const end = closingBrace(instruction, cursor);
    if (end === -1) break;
    const artifactId = instruction.slice(cursor + 1, end);
    if (instruction[cursor - 1] !== '$' && !escaped(instruction, cursor) && identifier.test(artifactId) && allowed.has(artifactId)) {
      if (textStart < cursor) parts.push({ type: 'text', text: instruction.slice(textStart, cursor) });
      parts.push({ type: 'artifact', artifactId });
      textStart = end + 1;
    }
    cursor = end + 1;
  }
  if (textStart < instruction.length) parts.push({ type: 'text', text: instruction.slice(textStart) });
  return parts;
}

/** Presentation only: actual tool definitions remain in the existing tool channel. */
export function digestArtifactInstruction(instruction: string, artifacts: readonly { id: string }[], tools: readonly { artifactId: string; name: string }[]): string {
  const names = new Map<string, Set<string>>();
  for (const tool of tools) {
    if (!names.has(tool.artifactId)) names.set(tool.artifactId, new Set());
    names.get(tool.artifactId)!.add(tool.name);
  }
  return parseArtifactInstruction(instruction, artifacts).map(part => part.type === 'text' ? part.text
    : JSON.stringify({ artifact: part.artifactId, tools: [...(names.get(part.artifactId) ?? [])] })).join('');
}
