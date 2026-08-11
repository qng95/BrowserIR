import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

import { TASKS } from '../src/tasks.js';

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const tasksPath = fileURLToPath(new URL('../src/tasks.ts', import.meta.url));
const contractsPath = fileURLToPath(
  new URL('../src/task-oracle-contracts.ts', import.meta.url),
);
const temporaryDirectories: string[] = [];

type VersionSnapshot = Array<{ id: string; oracleVersion: string }>;

const currentSnapshot = (): VersionSnapshot =>
  TASKS.map(({ id, oracleVersion }) => ({ id, oracleVersion }));

const parseSnapshot = (stdout: string): VersionSnapshot =>
  JSON.parse(stdout.trim()) as VersionSnapshot;

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('task oracle version runtime stability', () => {
  it('is identical under Vitest, vite-node, and transpiled Node execution', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'browserir-task-versions-'));
    temporaryDirectories.push(temporaryDirectory);
    const sourceUrl = pathToFileURL(tasksPath).href;
    const expression =
      "TASKS.map(({ id, oracleVersion }) => ({ id, oracleVersion }))";

    const viteProbe = join(temporaryDirectory, 'vite-probe.ts');
    await writeFile(
      viteProbe,
      `import { TASKS } from ${JSON.stringify(sourceUrl)};\nprocess.stdout.write(JSON.stringify(${expression}));\n`,
      'utf8',
    );
    const viteNodeCli = require.resolve('vite-node/cli');
    const viteSnapshot = parseSnapshot(
      (
        await execFile(process.execPath, [viteNodeCli, '--root', workspaceRoot, viteProbe], {
          cwd: packageRoot,
        })
      ).stdout,
    );

    const builtProbe = join(temporaryDirectory, 'tasks.mjs');
    const compilerOptions = {
      module: ModuleKind.ESNext,
      target: ScriptTarget.ES2022,
    } as const;
    const transpiledContract = transpileModule(
      await readFile(contractsPath, 'utf8'),
      { fileName: contractsPath, compilerOptions },
    ).outputText;
    await writeFile(
      join(temporaryDirectory, 'task-oracle-contracts.js'),
      transpiledContract,
      'utf8',
    );
    const transpiled = transpileModule(await readFile(tasksPath, 'utf8'), {
      fileName: tasksPath,
      compilerOptions,
    }).outputText;
    await writeFile(
      builtProbe,
      `${transpiled}\nprocess.stdout.write(JSON.stringify(${expression}));\n`,
      'utf8',
    );
    const builtSnapshot = parseSnapshot(
      (await execFile(process.execPath, [builtProbe], { cwd: packageRoot })).stdout,
    );

    expect(viteSnapshot).toEqual(currentSnapshot());
    expect(builtSnapshot).toEqual(currentSnapshot());
  });
});
