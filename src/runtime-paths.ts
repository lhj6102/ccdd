import { readFileSync } from 'node:fs';

// Runtime files live under dist/src in both development builds and installed packages.
export const packageVersion: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
