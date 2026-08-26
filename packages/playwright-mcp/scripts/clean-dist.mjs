import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = resolve(packageRoot, 'dist');

if (dirname(output) !== packageRoot || output === packageRoot) {
  throw new Error(`Refusing to clean unexpected package output: ${output}`);
}

rmSync(output, { recursive: true, force: true });
