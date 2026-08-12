import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { stableJson } from '../src/environment.js';
import type {
  CollectInstalledRuntimeProvenanceInput,
  InstalledRuntimePackageInput,
} from '../src/agent-benchmark/control-capability-runtime-provenance.js';
import {
  assertPairedRuntimeProvenanceStable,
  collectPairedInstalledRuntimeProvenance,
  PAIRED_CONTROL_RUNTIME_PACKAGE_NAMES,
  PAIRED_TREATMENT_RUNTIME_PACKAGE_NAMES,
  parsePairedRuntimeProvenance,
  renderPairedRuntimeProvenance,
} from '../src/agent-benchmark/paired-runtime-provenance.js';
import { resolveBrowserIrMcpRuntimePackageInputs } from '../src/agent-benchmark/browserir-mcp-runtime-boundary.js';
import { resolveBrowserIrPlaywrightRuntimePackageInputs } from '../src/agent-benchmark/browserir-playwright-runtime-boundary.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
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
  role: 'control' | 'treatment',
  name: string,
): Promise<InstalledRuntimePackageInput> {
  const directory = join(
    root,
    role,
    name.replaceAll('/', '__').replaceAll('@', 'scope-'),
  );
  await mkdir(join(directory, 'lib'), { recursive: true });
  await writeFile(
    join(directory, 'package.json'),
    `${JSON.stringify({ name, version: '1.2.3', type: 'module' }, null, 2)}\n`,
  );
  await writeFile(
    join(directory, 'lib', 'index.js'),
    `export const role = ${JSON.stringify(role)};\n`,
  );
  return { name, packageDirectory: directory };
}

async function fixture(): Promise<{
  root: string;
  roles: Record<'control' | 'treatment', CollectInstalledRuntimeProvenanceInput>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'browserir-paired-runtime-'));
  temporaryDirectories.push(root);
  const roles = {} as Record<
    'control' | 'treatment',
    CollectInstalledRuntimeProvenanceInput
  >;
  for (const role of ['control', 'treatment'] as const) {
    const executablePath = join(root, role, 'chromium');
    await mkdir(join(root, role), { recursive: true });
    await writeFile(
      executablePath,
      role === 'control'
        ? Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01])
        : Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]),
    );
    roles[role] = {
      packages: await Promise.all(
        (role === 'control'
          ? PAIRED_CONTROL_RUNTIME_PACKAGE_NAMES
          : PAIRED_TREATMENT_RUNTIME_PACKAGE_NAMES
        ).map((name) => packageFixture(root, role, name)),
      ),
      browser: {
        engine: 'chromium',
        executablePath,
        launchVersion: async () =>
          role === 'control' ? '151.0.7922.34-control' : '151.0.7922.34-treatment',
      },
    };
  }
  return { root, roles };
}

describe('paired installed-runtime provenance', () => {
  it('round-trips one canonical, role-qualified control and treatment snapshot', async () => {
    const state = await fixture();
    const snapshot = await collectPairedInstalledRuntimeProvenance({
      roles: state.roles,
    });
    const rendered = renderPairedRuntimeProvenance(snapshot);

    expect(parsePairedRuntimeProvenance(JSON.parse(rendered) as unknown)).toEqual(
      snapshot,
    );
    expect(snapshot.roles.control.browser.version).toContain('control');
    expect(snapshot.roles.treatment.browser.version).toContain('treatment');
    expect(snapshot.roles.treatment.packages.map(({ name }) => name)).toContain(
      'playwright-core',
    );
    expect(snapshot.roles.treatment.packages.map(({ name }) => name)).toContain(
      '@modelcontextprotocol/server',
    );
    expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(rendered).not.toContain(state.root);
  });

  it('rejects a missing, renamed, or unexpected role', async () => {
    const state = await fixture();
    const snapshot = await collectPairedInstalledRuntimeProvenance({
      roles: state.roles,
    });

    expect(() =>
      parsePairedRuntimeProvenance({
        ...snapshot,
        roles: { control: snapshot.roles.control },
      }),
    ).toThrow(/treatment|role/i);
    expect(() =>
      parsePairedRuntimeProvenance({
        ...snapshot,
        roles: { ...snapshot.roles, shadow: snapshot.roles.treatment },
      }),
    ).toThrow(/unrecognized|role/i);
  });

  it.each([
    ['control', '@playwright/mcp'],
    ['treatment', '@modelcontextprotocol/server'],
  ] as const)('rejects a stable-looking %s snapshot missing %s', async (role, missingName) => {
    const state = await fixture();
    const snapshot = await collectPairedInstalledRuntimeProvenance({
      roles: state.roles,
    });
    const retainedRole = snapshot.roles[role];
    const unsignedRole = {
      schemaVersion: retainedRole.schemaVersion,
      packages: retainedRole.packages.filter(({ name }) => name !== missingName),
      browser: retainedRole.browser,
    };
    const forgedRole = { ...unsignedRole, sha256: sha256(stableJson(unsignedRole)) };
    const roles = { ...snapshot.roles, [role]: forgedRole };
    const forged = {
      schemaVersion: snapshot.schemaVersion,
      roles,
      sha256: sha256(
        stableJson({ schemaVersion: snapshot.schemaVersion, roles }),
      ),
    };

    expect(() => parsePairedRuntimeProvenance(forged)).toThrow(
      new RegExp(`${role}.*incomplete|incomplete.*${role}`, 'i'),
    );
  });

  it('detects treatment Playwright payload drift independently of control', async () => {
    const state = await fixture();
    const start = await collectPairedInstalledRuntimeProvenance({ roles: state.roles });
    const treatmentCore = state.roles.treatment.packages.find(
      ({ name }) => name === 'playwright-core',
    )!;
    await writeFile(
      join(treatmentCore.packageDirectory, 'lib', 'index.js'),
      'export const changed = true;\n',
    );
    const end = await collectPairedInstalledRuntimeProvenance({ roles: state.roles });

    expect(start.roles.control).toEqual(end.roles.control);
    expect(() => assertPairedRuntimeProvenanceStable(start, end)).toThrow(
      /treatment.*playwright-core.*lib\/index\.js|treatment.*content.*playwright-core/i,
    );
  });

  it('detects treatment Chromium bytes and version drift independently of control', async () => {
    const bytesState = await fixture();
    const bytesStart = await collectPairedInstalledRuntimeProvenance({
      roles: bytesState.roles,
    });
    await writeFile(
      bytesState.roles.treatment.browser.executablePath,
      Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    );
    const bytesEnd = await collectPairedInstalledRuntimeProvenance({
      roles: bytesState.roles,
    });
    expect(bytesStart.roles.control).toEqual(bytesEnd.roles.control);
    expect(() => assertPairedRuntimeProvenanceStable(bytesStart, bytesEnd)).toThrow(
      /treatment.*Chromium.*content|treatment.*executable/i,
    );

    const versionState = await fixture();
    const versionStart = await collectPairedInstalledRuntimeProvenance({
      roles: versionState.roles,
    });
    versionState.roles.treatment.browser.launchVersion = async () => '152.0.0.0';
    const versionEnd = await collectPairedInstalledRuntimeProvenance({
      roles: versionState.roles,
    });
    expect(() => assertPairedRuntimeProvenanceStable(versionStart, versionEnd)).toThrow(
      /treatment.*Chromium.*version/i,
    );
  });

  it('binds the aggregate digest to both exact role snapshots', async () => {
    const state = await fixture();
    const snapshot = await collectPairedInstalledRuntimeProvenance({
      roles: state.roles,
    });
    const unsigned = {
      schemaVersion: snapshot.schemaVersion,
      roles: snapshot.roles,
    };

    expect(snapshot.sha256).toBe(sha256(stableJson(unsigned)));
    expect(() =>
      parsePairedRuntimeProvenance({ ...snapshot, sha256: '0'.repeat(64) }),
    ).toThrow(/aggregate digest/i);
  });

  it('resolves exact role package lists through the actual treatment boundaries', () => {
    expect([...PAIRED_CONTROL_RUNTIME_PACKAGE_NAMES].sort()).toEqual([
      '@langchain/core',
      '@langchain/openai',
      '@modelcontextprotocol/client',
      '@playwright/mcp',
      'langchain',
      'openai',
      'playwright',
      'playwright-core',
    ]);
    expect([...PAIRED_TREATMENT_RUNTIME_PACKAGE_NAMES].sort()).toEqual([
      '@langchain/core',
      '@langchain/openai',
      '@modelcontextprotocol/client',
      '@modelcontextprotocol/server',
      'langchain',
      'openai',
      'playwright',
      'playwright-core',
    ]);
    const treatmentBoundary = [
      ...resolveBrowserIrMcpRuntimePackageInputs(),
      ...resolveBrowserIrPlaywrightRuntimePackageInputs(),
    ];
    expect(treatmentBoundary.map(({ name }) => name)).toEqual([
      '@modelcontextprotocol/server',
      'playwright',
      'playwright-core',
    ]);
    expect(treatmentBoundary.every(({ packageDirectory }) => isAbsolute(packageDirectory))).toBe(
      true,
    );
  });
});
