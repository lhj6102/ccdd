import { registerHooks } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { within } from './paths.js';

const root = realpathSync(process.argv[2]);
const script = realpathSync(process.argv[3]);
if (!within(root, script)) throw new Error('Environment script is outside the reviewed snapshot.');
registerHooks({
  resolve(specifier, context, next) {
    let result;
    try { result = next(specifier, context); }
    catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) result = next(`${specifier.slice(0, -3)}.ts`, context);
      else throw error;
    }
    if (result.url.startsWith('file:')) {
      if (!within(root, realpathSync(fileURLToPath(result.url)))) throw new Error('Environment script imports must resolve inside the snapshot.');
    } else if (!result.url.startsWith('node:')) throw new Error('Environment scripts may import only snapshot files and Node builtins.');
    return result;
  },
});
process.argv = [process.execPath, script];
await import(pathToFileURL(script).href);
