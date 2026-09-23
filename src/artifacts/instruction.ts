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

/** Extract only bare reference tokens; all existing literal and escape rules apply. */
export function instructionReferences(instruction: string): string[] {
  const result = new Set<string>();
  let cursor = 0;
  while (cursor < instruction.length) {
    if (instruction[cursor] !== '{') { cursor++; continue; }
    const end = closingBrace(instruction, cursor);
    if (end === -1) break;
    const id = instruction.slice(cursor + 1, end);
    if (instruction[cursor - 1] !== '$' && !escaped(instruction, cursor) && identifier.test(id)) result.add(id);
    cursor = end + 1;
  }
  return [...result];
}

/** Render references only within the already admitted scope, preserving the stored source. */
export function parseArtifactInstruction(instruction: string, artifacts: readonly { id: string }[], references: Readonly<Record<string, string>> = {}): InstructionPart[] {
  const allowed = new Set(artifacts.map(artifact => artifact.id));
  const parts: InstructionPart[] = [];
  let textStart = 0, cursor = 0;
  while (cursor < instruction.length) {
    if (instruction[cursor] !== '{') { cursor++; continue; }
    const end = closingBrace(instruction, cursor);
    if (end === -1) break;
    const name = instruction.slice(cursor + 1, end), artifactId = Object.hasOwn(references, name) ? references[name] : name;
    if (instruction[cursor - 1] !== '$' && !escaped(instruction, cursor) && identifier.test(name) && allowed.has(artifactId)) {
      if (textStart < cursor) parts.push({ type: 'text', text: instruction.slice(textStart, cursor) });
      parts.push({ type: 'artifact', artifactId }); textStart = end + 1;
    }
    cursor = end + 1;
  }
  if (textStart < instruction.length) parts.push({ type: 'text', text: instruction.slice(textStart) });
  return parts;
}

/** Presentation only: actual definitions remain in the tool channel. */
export function digestArtifactInstruction(instruction: string, artifacts: readonly { id: string }[], tools: readonly { artifactId: string; name: string }[], references: Readonly<Record<string, string>> = {}): string {
  return parseArtifactInstruction(instruction, artifacts, references).map(part => part.type === 'text' ? part.text
    : JSON.stringify({ artifact: part.artifactId, tools: tools.filter(tool => tool.artifactId === part.artifactId).map(tool => tool.name) })).join('');
}
