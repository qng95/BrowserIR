import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const allowedDirectories = new Set(
  [
    'packages/browser-ir',
    'packages/playwright-driver',
    'packages/mcp-server',
  ].map((directory) => resolve(workspaceRoot, directory, 'dist')),
);
const target = resolve(process.cwd(), 'dist');

if (!allowedDirectories.has(target)) {
  throw new Error(`Refusing to clean unexpected package output: ${target}`);
}

rmSync(target, { recursive: true, force: true });
