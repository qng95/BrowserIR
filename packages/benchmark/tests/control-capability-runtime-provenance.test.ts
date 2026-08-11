import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertInstalledRuntimeProvenanceStable,
  collectInstalledRuntimeProvenance,
  CONTROL_CAPABILITY_RUNTIME_PACKAGE_NAMES,
  parseInstalledRuntimeProvenance,
  renderInstalledRuntimeProvenance,
  type InstalledRuntimePackageInput,
} from '../src/agent-benchmark/control-capability-runtime-provenance.js';
import {
  CONTROL_CAPABILITY_AGENT_RUNTIME_PACKAGE_NAMES,
  resolveControlCapabilityAgentRuntimePackageInputs,
} from '../src/agent-benchmark/control-capability-agent-runtime-boundary.js';
import {
  PLAYWRIGHT_MCP_RUNTIME_PACKAGE_NAMES,
  playwrightMcpChromiumExecutablePath,
  resolvePlaywrightMcpRuntimePackageInputs,
} from '../src/agent-benchmark/playwright-mcp-runtime-boundary.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

async function packageFixture(
  root: string,
  name: string,
): Promise<InstalledRuntimePackageInput> {
  const directory = join(root, name.replaceAll('/', '__').replaceAll('@', 'scope-'));
  await mkdir(join(directory, 'lib', 'nested'), { recursive: true });
  await writeFile(
    join(directory, 'package.json'),
    `${JSON.stringify({ name, version: '1.2.3', type: 'module' }, null, 2)}\n`,
  );
  await writeFile(join(directory, 'lib', 'index.js'), `export const name = ${JSON.stringify(name)};\n`);
  await writeFile(join(directory, 'lib', 'loader.cjs'), `exports.name = ${JSON.stringify(name)};\n`);
  await writeFile(join(directory, 'lib', 'nested', 'worker.mjs'), 'export default 42;\n');
  await writeFile(join(directory, 'lib', 'index.d.ts'), 'export declare const name: string;\n');
  await writeFile(join(directory, 'README.md'), 'ignored documentation\n');
  return { name, packageDirectory: directory };
}

async function fixture(): Promise<{
  root: string;
  packages: InstalledRuntimePackageInput[];
  executablePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'browserir-installed-runtime-'));
  temporaryDirectories.push(root);
  const executablePath = join(root, 'chromium');
  await writeFile(executablePath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
  return {
    root,
    packages: await Promise.all([
      packageFixture(root, '@langchain/core'),
      packageFixture(root, '@langchain/openai'),
      packageFixture(root, '@playwright/mcp'),
      packageFixture(root, 'langchain'),
      packageFixture(root, 'openai'),
      packageFixture(root, 'playwright'),
      packageFixture(root, 'playwright-core'),
      packageFixture(root, '@modelcontextprotocol/client'),
    ]),
    executablePath,
  };
}

const collectFixture = (
  state: Awaited<ReturnType<typeof fixture>>,
  version = '144.0.7559.3',
) =>
  collectInstalledRuntimeProvenance({
    packages: state.packages,
    browser: {
      engine: 'chromium',
      executablePath: state.executablePath,
      launchVersion: async (executablePath) => {
        expect(executablePath).toBe(state.executablePath);
        return version;
      },
    },
  });

describe('control capability installed-runtime provenance', () => {
  it('hashes exact manifests, all package payloads, and selected browser bytes canonically', async () => {
    const state = await fixture();
    const forward = await collectFixture(state);
    const reverse = await collectInstalledRuntimeProvenance({
      packages: [...state.packages].reverse(),
      browser: {
        engine: 'chromium',
        executablePath: state.executablePath,
        launchVersion: async () => '144.0.7559.3',
      },
    });

    expect(reverse).toEqual(forward);
    expect(forward.packages.map((entry) => entry.name)).toEqual(
      [...CONTROL_CAPABILITY_RUNTIME_PACKAGE_NAMES].sort(),
    );
    expect(forward.packages.map((entry) => entry.name)).toEqual([
      '@langchain/core',
      '@langchain/openai',
      '@modelcontextprotocol/client',
      '@playwright/mcp',
      'langchain',
      'openai',
      'playwright',
      'playwright-core',
    ]);
    for (const packageEntry of forward.packages) {
      expect(packageEntry.files.map((file) => file.path)).toEqual([
        'README.md',
        'lib/index.d.ts',
        'lib/index.js',
        'lib/loader.cjs',
        'lib/nested/worker.mjs',
        'package.json',
      ]);
      expect(packageEntry.files.find((file) => file.path === 'package.json')?.kind).toBe(
        'package_manifest',
      );
      expect(
        packageEntry.files
          .filter((file) => file.path !== 'package.json')
          .every((file) => file.kind === 'package_payload'),
      ).toBe(true);
    }
    const executable = await readFile(state.executablePath);
    expect(forward.browser).toEqual({
      engine: 'chromium',
      version: '144.0.7559.3',
      executableBytes: executable.byteLength,
      executableSha256: sha256(executable),
    });
    expect(forward.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('round-trips only canonical strict artifacts', async () => {
    const state = await fixture();
    const snapshot = await collectFixture(state);
    const rendered = renderInstalledRuntimeProvenance(snapshot);

    expect(parseInstalledRuntimeProvenance(JSON.parse(rendered) as unknown)).toEqual(snapshot);
    expect(renderInstalledRuntimeProvenance(JSON.parse(rendered) as unknown)).toBe(rendered);
    expect(() =>
      parseInstalledRuntimeProvenance({ ...snapshot, executablePath: state.executablePath }),
    ).toThrow(/invalid installed runtime provenance.*unrecognized/i);
    expect(() =>
      parseInstalledRuntimeProvenance({ ...snapshot, sha256: '0'.repeat(64) }),
    ).toThrow(/aggregate digest/i);
  });

  it('detects package payload and manifest byte drift between start and end', async () => {
    const jsState = await fixture();
    const jsStart = await collectFixture(jsState);
    await writeFile(
      join(jsState.packages[2]!.packageDirectory, 'lib', 'index.js'),
      'export const changed = true;\n',
    );
    const jsEnd = await collectFixture(jsState);
    expect(() => assertInstalledRuntimeProvenanceStable(jsStart, jsEnd)).toThrow(
      /@playwright\/mcp.*lib\/index\.js.*content|content.*@playwright\/mcp.*lib\/index\.js/i,
    );

    const manifestState = await fixture();
    const manifestStart = await collectFixture(manifestState);
    await writeFile(
      join(manifestState.packages[5]!.packageDirectory, 'package.json'),
      '{"name":"playwright","version":"1.2.3","type":"module"}\n',
    );
    const manifestEnd = await collectFixture(manifestState);
    expect(() => assertInstalledRuntimeProvenanceStable(manifestStart, manifestEnd)).toThrow(
      /playwright.*package\.json.*content|content.*playwright.*package\.json/i,
    );
  });

  it('detects added, removed, and renamed package payloads', async () => {
    const added = await fixture();
    const addedStart = await collectFixture(added);
    await writeFile(
      join(added.packages[6]!.packageDirectory, 'lib', 'late.js'),
      'export {};\n',
    );
    const addedEnd = await collectFixture(added);
    expect(() => assertInstalledRuntimeProvenanceStable(addedStart, addedEnd)).toThrow(
      /playwright-core.*unexpected.*lib\/late\.js|unexpected.*playwright-core.*lib\/late\.js/i,
    );

    const renamed = await fixture();
    const renamedStart = await collectFixture(renamed);
    await rename(
      join(renamed.packages[2]!.packageDirectory, 'lib', 'index.js'),
      join(renamed.packages[2]!.packageDirectory, 'lib', 'renamed.js'),
    );
    const renamedEnd = await collectFixture(renamed);
    expect(() => assertInstalledRuntimeProvenanceStable(renamedStart, renamedEnd)).toThrow(
      /missing.*lib\/index\.js.*unexpected.*lib\/renamed\.js/i,
    );
  });

  it('detects selected Chromium bytes or launched-version drift', async () => {
    const bytesState = await fixture();
    const bytesStart = await collectFixture(bytesState);
    await writeFile(bytesState.executablePath, Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
    const bytesEnd = await collectFixture(bytesState);
    expect(() => assertInstalledRuntimeProvenanceStable(bytesStart, bytesEnd)).toThrow(
      /Chromium executable.*content|executable.*changed/i,
    );

    const versionState = await fixture();
    const versionStart = await collectFixture(versionState, '144.0.7559.3');
    const versionEnd = await collectFixture(versionState, '145.0.0.0');
    expect(() => assertInstalledRuntimeProvenanceStable(versionStart, versionEnd)).toThrow(
      /Chromium.*version.*drift/i,
    );
  });

  it('fails closed for package identity drift, missing payloads, and symlink payloads', async () => {
    const wrongName = await fixture();
    await writeFile(
      join(wrongName.packages[2]!.packageDirectory, 'package.json'),
      '{"name":"lookalike","version":"1.2.3"}\n',
    );
    await expect(collectFixture(wrongName)).rejects.toThrow(/package name mismatch/i);

    const noJavaScript = await fixture();
    await rm(join(noJavaScript.packages[5]!.packageDirectory, 'lib'), { recursive: true });
    await rm(join(noJavaScript.packages[5]!.packageDirectory, 'README.md'));
    await expect(collectFixture(noJavaScript)).rejects.toThrow(
      /no package payload.*playwright/i,
    );

    const linked = await fixture();
    await symlink(
      'index.js',
      join(linked.packages[6]!.packageDirectory, 'lib', 'alias.js'),
    );
    await expect(collectFixture(linked)).rejects.toThrow(/symlink.*alias\.js/i);
  });

  it('resolves MCP Playwright dependencies from the same package import boundary', () => {
    const inputs = resolvePlaywrightMcpRuntimePackageInputs();
    expect(inputs.map((entry) => entry.name)).toEqual(PLAYWRIGHT_MCP_RUNTIME_PACKAGE_NAMES);

    const brokerLoader = createRequire(
      new URL('../src/agent-benchmark/playwright-mcp-broker.ts', import.meta.url),
    );
    const client = inputs.find((entry) => entry.name === '@modelcontextprotocol/client')!;
    for (const specifier of [
      '@modelcontextprotocol/client',
      '@modelcontextprotocol/client/stdio',
    ]) {
      const entryPath = brokerLoader.resolve(specifier);
      expect(relative(client.packageDirectory, entryPath)).not.toMatch(/^\.\.(?:\/|$)/u);
    }

    const mcp = inputs.find((entry) => entry.name === '@playwright/mcp')!;
    const mcpLoader = createRequire(join(mcp.packageDirectory, 'cli.js'));
    expect(inputs.find((entry) => entry.name === 'playwright')?.packageDirectory).toBe(
      dirname(mcpLoader.resolve('playwright/package.json')),
    );
    expect(inputs.find((entry) => entry.name === 'playwright-core')?.packageDirectory).toBe(
      dirname(mcpLoader.resolve('playwright-core/package.json')),
    );
    expect(playwrightMcpChromiumExecutablePath()).not.toContain('\n');

    const agentInputs = resolveControlCapabilityAgentRuntimePackageInputs();
    expect(agentInputs.map((entry) => entry.name)).toEqual(
      CONTROL_CAPABILITY_AGENT_RUNTIME_PACKAGE_NAMES,
    );
    expect(agentInputs.every((entry) => isAbsolute(entry.packageDirectory))).toBe(true);
  });
});
