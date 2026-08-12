import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createSealedUpliftEnvironment,
  launchSealedUplift,
  parseSealedUpliftArguments,
  type SealedUpliftCommand,
} from '../../../scripts/run-sealed-uplift.mjs';

const protocolPath = 'docs/evidence-drops/drop-01/sealed.protocol.json';
const freezeRef = 'refs/tags/evidence-drop-01-protocol-v1';
const protocolSource = `${JSON.stringify(
  { phase: 'sealed', freezeRef, agent: { provider: 'ollama' } },
  null,
  2,
)}\n`;
const openRouterProtocolSource = `${JSON.stringify(
  {
    phase: 'sealed',
    freezeRef,
    agent: { provider: 'openrouter', apiKeyEnv: 'OPENROUTER_API_KEY' },
  },
  null,
  2,
)}\n`;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(source = protocolSource): Promise<{
  root: string;
  sourceRoot: string;
  temporaryParentDirectory: string;
  outputDirectory: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'browserir-sealed-launcher-test-')));
  roots.push(root);
  const sourceRoot = join(root, 'source');
  const temporaryParentDirectory = join(root, 'temporary');
  const outputDirectory = join(root, 'retained', 'drop-01');
  await mkdir(join(sourceRoot, dirname(protocolPath)), { recursive: true });
  await mkdir(temporaryParentDirectory, { recursive: true });
  await writeFile(join(sourceRoot, protocolPath), source, 'utf8');
  return { root, sourceRoot, temporaryParentDirectory, outputDirectory };
}

function recordingRunner(options: {
  sourceRoot: string;
  calls: SealedUpliftCommand[];
  environments?: Readonly<Record<string, string>>[];
  frozenProtocolSource?: string;
  failPnpmScript?: string;
}) {
  return async (
    command: SealedUpliftCommand,
    environment: Readonly<Record<string, string>>,
  ): Promise<void> => {
    options.calls.push(command);
    options.environments?.push(environment);
    if (command.command === 'git' && command.args[0] === 'clone') {
      const checkout = command.args.at(-1)!;
      await mkdir(join(checkout, dirname(protocolPath)), { recursive: true });
      await writeFile(
        join(checkout, protocolPath),
        options.frozenProtocolSource ?? protocolSource,
        'utf8',
      );
    }
    if (
      command.command === 'corepack' &&
      command.args[0] === 'pnpm' &&
      command.args[1] === options.failPnpmScript
    ) {
      throw new Error(`simulated ${command.args[1]} failure`);
    }
    if (command.command === 'corepack' && command.args[1] === 'benchmark:uplift') {
      const evidenceOptionIndex = Math.max(
        command.args.indexOf('--output'),
        command.args.indexOf('--resume'),
      );
      const evidenceDirectory = command.args[evidenceOptionIndex + 1]!;
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(join(evidenceDirectory, 'retained.txt'), 'retained\n', 'utf8');
    }
  };
}

describe('sealed uplift launcher', () => {
  it('uses an isolated child environment without loader injection or ambient secrets', () => {
    const environment = createSealedUpliftEnvironment(
      {
        PATH: '/usr/bin:/bin',
        TERM: 'xterm-256color',
        PLAYWRIGHT_BROWSERS_PATH: '/opt/browsers',
        NODE_OPTIONS: '--import /tmp/inject.mjs',
        NODE_PATH: '/tmp/modules',
        DYLD_INSERT_LIBRARIES: '/tmp/inject.dylib',
        OPENAI_API_KEY: 'secret',
        NPM_CONFIG_USERCONFIG: '/tmp/host-npmrc',
      },
      '/private/tmp/browserir-sealed-home',
    );

    expect(environment).toMatchObject({
      PATH: '/usr/bin:/bin',
      TERM: 'xterm-256color',
      PLAYWRIGHT_BROWSERS_PATH: '/opt/browsers',
      HOME: '/private/tmp/browserir-sealed-home/home',
      COREPACK_HOME: '/private/tmp/browserir-sealed-home/corepack',
      NPM_CONFIG_USERCONFIG: '/private/tmp/browserir-sealed-home/npmrc',
    });
    expect(environment).not.toHaveProperty('NODE_OPTIONS');
    expect(environment).not.toHaveProperty('NODE_PATH');
    expect(environment).not.toHaveProperty('DYLD_INSERT_LIBRARIES');
    expect(environment).not.toHaveProperty('OPENAI_API_KEY');
    expect(environment).not.toHaveProperty('OPENROUTER_API_KEY');
  });

  it('forwards the declared OpenRouter key only to the final benchmark command', async () => {
    const setup = await fixture(openRouterProtocolSource);
    const calls: SealedUpliftCommand[] = [];
    const environments: Readonly<Record<string, string>>[] = [];
    const previousOpenRouterKey = process.env['OPENROUTER_API_KEY'];
    const previousOpenAiKey = process.env['OPENAI_API_KEY'];
    process.env['OPENROUTER_API_KEY'] = 'sealed-launcher-test-key';
    process.env['OPENAI_API_KEY'] = 'unrelated-test-key';

    try {
      await launchSealedUplift(
        ['--protocol', protocolPath, '--output', setup.outputDirectory],
        {
          sourceRoot: setup.sourceRoot,
          temporaryParentDirectory: setup.temporaryParentDirectory,
          runCommand: recordingRunner({
            sourceRoot: setup.sourceRoot,
            calls,
            environments,
            frozenProtocolSource: openRouterProtocolSource,
          }),
        },
      );
    } finally {
      if (previousOpenRouterKey === undefined) delete process.env['OPENROUTER_API_KEY'];
      else process.env['OPENROUTER_API_KEY'] = previousOpenRouterKey;
      if (previousOpenAiKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = previousOpenAiKey;
    }

    expect(calls).toHaveLength(5);
    expect(environments).toHaveLength(5);
    for (const setupEnvironment of environments.slice(0, -1)) {
      expect(setupEnvironment).not.toHaveProperty('OPENROUTER_API_KEY');
      expect(setupEnvironment).not.toHaveProperty('OPENAI_API_KEY');
    }
    const benchmarkCommand = calls.at(-1)!;
    const benchmarkEnvironment = environments.at(-1)!;
    expect(benchmarkCommand.args[1]).toBe('benchmark:uplift');
    expect(benchmarkEnvironment['OPENROUTER_API_KEY']).toBe('sealed-launcher-test-key');
    expect(benchmarkEnvironment).not.toHaveProperty('OPENAI_API_KEY');
    expect(benchmarkCommand.args).not.toContain('sealed-launcher-test-key');
    expect(benchmarkCommand).not.toHaveProperty('environment');
  });

  it.each([
    ['missing', undefined],
    ['blank', '   '],
  ] as const)(
    'fails after build and before benchmark when the declared OpenRouter key is %s',
    async (_case, providedKey) => {
      const setup = await fixture(openRouterProtocolSource);
      const calls: SealedUpliftCommand[] = [];
      const environments: Readonly<Record<string, string>>[] = [];
      const previousOpenRouterKey = process.env['OPENROUTER_API_KEY'];
      if (providedKey === undefined) delete process.env['OPENROUTER_API_KEY'];
      else process.env['OPENROUTER_API_KEY'] = providedKey;

      try {
        await expect(
          launchSealedUplift(
            ['--protocol', protocolPath, '--output', setup.outputDirectory],
            {
              sourceRoot: setup.sourceRoot,
              temporaryParentDirectory: setup.temporaryParentDirectory,
              runCommand: recordingRunner({
                sourceRoot: setup.sourceRoot,
                calls,
                environments,
                frozenProtocolSource: openRouterProtocolSource,
              }),
            },
          ),
        ).rejects.toThrow(/OPENROUTER_API_KEY.*required|requires.*OPENROUTER_API_KEY/i);
      } finally {
        if (previousOpenRouterKey === undefined) delete process.env['OPENROUTER_API_KEY'];
        else process.env['OPENROUTER_API_KEY'] = previousOpenRouterKey;
      }

      expect(calls.map(({ command, args }) => [command, ...args])).toEqual([
        [
          'git',
          'clone',
          '--no-checkout',
          '--local',
          '--no-hardlinks',
          '--',
          setup.sourceRoot,
          expect.stringContaining('browserir-sealed-uplift-'),
        ],
        ['git', '-c', 'advice.detachedHead=false', 'checkout', '--detach', freezeRef],
        ['corepack', 'pnpm', 'install', '--frozen-lockfile'],
        ['corepack', 'pnpm', 'build'],
      ]);
      expect(environments).toHaveLength(4);
      for (const setupEnvironment of environments) {
        expect(setupEnvironment).not.toHaveProperty('OPENROUTER_API_KEY');
      }
    },
  );

  it('refuses to source an arbitrary secret name from an OpenRouter manifest', async () => {
    const wrongSecretSource = `${JSON.stringify({
      phase: 'sealed',
      freezeRef,
      agent: { provider: 'openrouter', apiKeyEnv: 'OTHER_API_KEY' },
    })}\n`;
    const setup = await fixture(wrongSecretSource);
    const calls: SealedUpliftCommand[] = [];

    await expect(
      launchSealedUplift(
        ['--protocol', protocolPath, '--output', setup.outputDirectory],
        {
          sourceRoot: setup.sourceRoot,
          temporaryParentDirectory: setup.temporaryParentDirectory,
          runCommand: recordingRunner({ sourceRoot: setup.sourceRoot, calls }),
        },
      ),
    ).rejects.toThrow(/must declare OPENROUTER_API_KEY/i);
    expect(calls).toEqual([]);
  });

  it('uses a fresh detached frozen checkout, frozen install, build, then the inner CLI', async () => {
    const setup = await fixture();
    const calls: SealedUpliftCommand[] = [];
    const environments: Readonly<Record<string, string>>[] = [];

    await launchSealedUplift(
      ['--protocol', protocolPath, '--output', setup.outputDirectory],
      {
        sourceRoot: setup.sourceRoot,
        temporaryParentDirectory: setup.temporaryParentDirectory,
        runCommand: recordingRunner({
          sourceRoot: setup.sourceRoot,
          calls,
          environments,
        }),
      },
    );

    expect(calls).toHaveLength(5);
    expect(environments).toHaveLength(5);
    for (const environment of environments) {
      expect(environment).not.toHaveProperty('OPENROUTER_API_KEY');
    }
    const checkout = calls[0]!.args.at(-1)!;
    expect(calls).toEqual([
      {
        command: 'git',
        args: [
          'clone',
          '--no-checkout',
          '--local',
          '--no-hardlinks',
          '--',
          setup.sourceRoot,
          checkout,
        ],
        cwd: setup.sourceRoot,
        stdio: 'inherit',
      },
      {
        command: 'git',
        args: ['-c', 'advice.detachedHead=false', 'checkout', '--detach', freezeRef],
        cwd: checkout,
        stdio: 'inherit',
      },
      {
        command: 'corepack',
        args: ['pnpm', 'install', '--frozen-lockfile'],
        cwd: checkout,
        stdio: 'inherit',
      },
      {
        command: 'corepack',
        args: ['pnpm', 'build'],
        cwd: checkout,
        stdio: 'inherit',
      },
      {
        command: 'corepack',
        args: [
          'pnpm',
          'benchmark:uplift',
          '--',
          '--protocol',
          protocolPath,
          '--output',
          setup.outputDirectory,
        ],
        cwd: checkout,
        stdio: 'inherit',
      },
    ]);
    await expect(readFile(join(checkout, protocolPath), 'utf8')).rejects.toThrow();
    await expect(readFile(join(setup.outputDirectory, 'retained.txt'), 'utf8')).resolves.toBe(
      'retained\n',
    );
  });

  it('forwards resume exactly and removes the temporary checkout when a command fails', async () => {
    const setup = await fixture();
    await mkdir(setup.outputDirectory, { recursive: true });
    const calls: SealedUpliftCommand[] = [];

    await expect(
      launchSealedUplift(
        ['--protocol', protocolPath, '--resume', setup.outputDirectory],
        {
          sourceRoot: setup.sourceRoot,
          temporaryParentDirectory: setup.temporaryParentDirectory,
          runCommand: recordingRunner({
            sourceRoot: setup.sourceRoot,
            calls,
            failPnpmScript: 'benchmark:uplift',
          }),
        },
      ),
    ).rejects.toThrow(/simulated benchmark:uplift failure/i);

    expect(calls.map(({ command, args }) => [command, ...args])).toEqual([
      [
        'git',
        'clone',
        '--no-checkout',
        '--local',
        '--no-hardlinks',
        '--',
        setup.sourceRoot,
        expect.stringContaining('browserir-sealed-uplift-'),
      ],
      ['git', '-c', 'advice.detachedHead=false', 'checkout', '--detach', freezeRef],
      ['corepack', 'pnpm', 'install', '--frozen-lockfile'],
      ['corepack', 'pnpm', 'build'],
      [
        'corepack',
        'pnpm',
        'benchmark:uplift',
        '--',
        '--protocol',
        protocolPath,
        '--resume',
        setup.outputDirectory,
      ],
    ]);
    const checkout = calls[0]!.args.at(-1)!;
    await expect(readFile(join(checkout, protocolPath), 'utf8')).rejects.toThrow();
  });

  it('requires one explicit absolute external output or resume directory', async () => {
    expect(() => parseSealedUpliftArguments(['--protocol', protocolPath])).toThrow(
      /--output.*--resume|required/i,
    );
    expect(() =>
      parseSealedUpliftArguments([
        '--protocol',
        protocolPath,
        '--output',
        '/tmp/new',
        '--resume',
        '/tmp/old',
      ]),
    ).toThrow(/cannot.*together|exactly one/i);
    expect(() =>
      parseSealedUpliftArguments(['--protocol', protocolPath, '--output', 'relative']),
    ).toThrow(/absolute/i);
    expect(() =>
      parseSealedUpliftArguments(['--protocol', '../outside.json', '--output', '/tmp/drop']),
    ).toThrow(/protocol.*relative|traversal|inside/i);
    expect(() =>
      parseSealedUpliftArguments([
        '--protocol',
        protocolPath,
        '--output',
        '/tmp/one',
        '--output',
        '/tmp/two',
      ]),
    ).toThrow(/duplicate/i);
    expect(() =>
      parseSealedUpliftArguments([
        '--protocol',
        protocolPath,
        '--output',
        '/tmp/drop',
        '--model',
        'anything',
      ]),
    ).toThrow(/unknown/i);

    const setup = await fixture();
    await expect(
      launchSealedUplift(
        ['--protocol', protocolPath, '--output', join(setup.sourceRoot, 'evidence')],
        {
          sourceRoot: setup.sourceRoot,
          temporaryParentDirectory: setup.temporaryParentDirectory,
          runCommand: async () => {
            throw new Error('must not execute');
          },
        },
      ),
    ).rejects.toThrow(/evidence.*outside.*source|external/i);
  });

  it('rejects a non-sealed or changed frozen manifest before install or benchmark execution', async () => {
    const setup = await fixture();
    const calls: SealedUpliftCommand[] = [];
    const changedFrozenSource = `${JSON.stringify({
      phase: 'sealed',
      freezeRef,
      unexpectedChange: true,
    })}\n`;

    await expect(
      launchSealedUplift(
        ['--protocol', protocolPath, '--output', setup.outputDirectory],
        {
          sourceRoot: setup.sourceRoot,
          temporaryParentDirectory: setup.temporaryParentDirectory,
          runCommand: recordingRunner({
            sourceRoot: setup.sourceRoot,
            calls,
            frozenProtocolSource: changedFrozenSource,
          }),
        },
      ),
    ).rejects.toThrow(/manifest.*differ|bytes.*differ|frozen.*manifest/i);

    expect(calls.map((call) => call.command)).toEqual(['git', 'git']);

    await writeFile(
      join(setup.sourceRoot, protocolPath),
      JSON.stringify({ phase: 'development' }),
      'utf8',
    );
    await expect(
      launchSealedUplift(
        ['--protocol', protocolPath, '--output', setup.outputDirectory],
        {
          sourceRoot: setup.sourceRoot,
          temporaryParentDirectory: setup.temporaryParentDirectory,
          runCommand: async () => {
            throw new Error('must not execute');
          },
        },
      ),
    ).rejects.toThrow(/sealed.*manifest|phase.*sealed/i);
  });
});
