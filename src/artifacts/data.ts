import { createHash } from 'node:crypto';

export const MAX_ARTIFACT_DATA_DEPTH = 64;
export const MAX_ARTIFACT_DATA_BYTES = 4 * 1024 * 1024;

/** Canonical JSON for fixed Artifact material; changing these rules requires a new identity version. */
export function canonicalData(value: unknown): string {
  const chunks: string[] = [];
  const ancestors = new Set<object>();
  let bytes = 0;

  function emit(text: string): void {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_ARTIFACT_DATA_BYTES) throw new RangeError(`Artifact data exceeds the ${MAX_ARTIFACT_DATA_BYTES}-byte canonical JSON limit.`);
    chunks.push(text);
  }

  function quote(text: string): void {
    // Avoid constructing an arbitrarily large escaped string before checking the byte limit.
    if (text.length > MAX_ARTIFACT_DATA_BYTES) throw new RangeError(`Artifact data exceeds the ${MAX_ARTIFACT_DATA_BYTES}-byte canonical JSON limit.`);
    emit(JSON.stringify(text));
  }

  function property(object: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Artifact data requires enumerable data properties; sparse arrays and accessors are unsupported.');
    }
    return descriptor.value;
  }

  function visit(current: unknown, depth: number): void {
    if (current === null) { emit('null'); return; }
    switch (typeof current) {
      case 'string': quote(current); return;
      case 'boolean': emit(current ? 'true' : 'false'); return;
      case 'number':
        if (!Number.isFinite(current)) throw new TypeError('Artifact data requires finite JSON numbers.');
        emit(JSON.stringify(current));
        return;
      case 'object': break;
      default: throw new TypeError('Artifact data supports only JSON values.');
    }

    if (depth >= MAX_ARTIFACT_DATA_DEPTH) throw new RangeError(`Artifact data exceeds ${MAX_ARTIFACT_DATA_DEPTH} nested containers.`);
    if (ancestors.has(current)) throw new TypeError('Artifact data must not contain cycles.');
    const array = Array.isArray(current);
    const prototype: unknown = Object.getPrototypeOf(current);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Artifact data requires plain objects and arrays.');
    }
    const keys = Reflect.ownKeys(current);
    if (keys.some(key => typeof key !== 'string')) throw new TypeError('Artifact data must not contain symbol properties.');
    ancestors.add(current);
    try {
      if (array) {
        if (keys.length !== current.length + 1 || keys.some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key as string))) {
          throw new TypeError('Artifact data arrays must be dense and have no extra properties.');
        }
        emit('[');
        for (let index = 0; index < current.length; index += 1) {
          if (index) emit(',');
          visit(property(current, String(index)), depth + 1);
        }
        emit(']');
      } else {
        // Default sort compares UTF-16 code units, independent of the host locale.
        const names = (keys as string[]).sort();
        emit('{');
        for (let index = 0; index < names.length; index += 1) {
          const name = names[index];
          const item = property(current, name);
          if (index) emit(',');
          quote(name);
          emit(':');
          visit(item, depth + 1);
        }
        emit('}');
      }
    } finally {
      ancestors.delete(current);
    }
  }

  visit(value, 0);
  return chunks.join('');
}

export function dataHash(value: unknown): string {
  return createHash('sha256').update(canonicalData(value), 'utf8').digest('hex');
}
