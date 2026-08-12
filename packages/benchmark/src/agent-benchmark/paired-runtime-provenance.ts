import { createHash } from 'node:crypto';

import { z } from 'zod';

import { stableJson } from '../environment.js';
import {
  BROWSERIR_MCP_RUNTIME_PACKAGE_NAMES,
  resolveBrowserIrMcpRuntimePackageInputs,
} from './browserir-mcp-runtime-boundary.js';
import {
  BROWSERIR_PLAYWRIGHT_RUNTIME_PACKAGE_NAMES,
  browserIrPlaywrightChromiumExecutablePath,
  probeBrowserIrPlaywrightChromiumVersion,
  resolveBrowserIrPlaywrightRuntimePackageInputs,
} from './browserir-playwright-runtime-boundary.js';
import {
  CONTROL_CAPABILITY_AGENT_RUNTIME_PACKAGE_NAMES,
  resolveControlCapabilityAgentRuntimePackageInputs,
} from './control-capability-agent-runtime-boundary.js';
import {
  assertInstalledRuntimeProvenanceStable,
  collectInstalledRuntimeProvenance,
  parseInstalledRuntimeProvenance,
  type CollectInstalledRuntimeProvenanceInput,
  type InstalledRuntimeProvenance,
} from './control-capability-runtime-provenance.js';
import {
  PLAYWRIGHT_MCP_RUNTIME_PACKAGE_NAMES,
  playwrightMcpChromiumExecutablePath,
  probePlaywrightMcpChromiumVersion,
  resolvePlaywrightMcpRuntimePackageInputs,
} from './playwright-mcp-runtime-boundary.js';

export const PAIRED_RUNTIME_PROVENANCE_SCHEMA_VERSION = '1.0.0' as const;

export const PAIRED_CONTROL_RUNTIME_PACKAGE_NAMES = [
  ...CONTROL_CAPABILITY_AGENT_RUNTIME_PACKAGE_NAMES,
  ...PLAYWRIGHT_MCP_RUNTIME_PACKAGE_NAMES,
] as const;

export const PAIRED_TREATMENT_RUNTIME_PACKAGE_NAMES = [
  ...CONTROL_CAPABILITY_AGENT_RUNTIME_PACKAGE_NAMES,
  '@modelcontextprotocol/client',
  ...BROWSERIR_MCP_RUNTIME_PACKAGE_NAMES,
  ...BROWSERIR_PLAYWRIGHT_RUNTIME_PACKAGE_NAMES,
] as const;

export interface PairedRuntimeProvenance {
  schemaVersion: typeof PAIRED_RUNTIME_PROVENANCE_SCHEMA_VERSION;
  roles: {
    control: InstalledRuntimeProvenance;
    treatment: InstalledRuntimeProvenance;
  };
  sha256: string;
}

export interface CollectPairedInstalledRuntimeProvenanceInput {
  roles: {
    control: CollectInstalledRuntimeProvenanceInput;
    treatment: CollectInstalledRuntimeProvenanceInput;
  };
}

const digestPattern = /^[a-f0-9]{64}$/;
const envelopeSchema = z
  .object({
    schemaVersion: z.literal(PAIRED_RUNTIME_PROVENANCE_SCHEMA_VERSION),
    roles: z
      .object({
        control: z.unknown(),
        treatment: z.unknown(),
      })
      .strict(),
    sha256: z.string().regex(digestPattern),
  })
  .strict();

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const aggregateDigest = (
  roles: PairedRuntimeProvenance['roles'],
): string =>
  sha256(
    stableJson({
      schemaVersion: PAIRED_RUNTIME_PROVENANCE_SCHEMA_VERSION,
      roles,
    }),
  );

function assertExactPackageNames(
  role: 'control' | 'treatment',
  packages: readonly { name: string }[],
  expected: readonly string[],
): void {
  const expectedNames = new Set(expected);
  if (
    packages.length !== expected.length ||
    new Set(packages.map(({ name }) => name)).size !== packages.length ||
    packages.some(({ name }) => !expectedNames.has(name))
  ) {
    throw new Error(`Paired ${role} runtime package resolution is incomplete.`);
  }
}

export async function collectPairedInstalledRuntimeProvenance(
  input: CollectPairedInstalledRuntimeProvenanceInput,
): Promise<PairedRuntimeProvenance> {
  const [control, treatment] = await Promise.all([
    collectInstalledRuntimeProvenance(input.roles.control),
    collectInstalledRuntimeProvenance(input.roles.treatment),
  ]);
  const roles = { control, treatment } as const;
  return {
    schemaVersion: PAIRED_RUNTIME_PROVENANCE_SCHEMA_VERSION,
    roles,
    sha256: aggregateDigest(roles),
  };
}

/** Collect exact installed runtime bytes and Chromium independently for each arm. */
export async function collectPairedUpliftRuntimeProvenance(): Promise<PairedRuntimeProvenance> {
  const agentPackages = resolveControlCapabilityAgentRuntimePackageInputs();
  const controlPackages = [
    ...agentPackages,
    ...resolvePlaywrightMcpRuntimePackageInputs(),
  ];
  const controlClient = controlPackages.find(
    ({ name }) => name === '@modelcontextprotocol/client',
  );
  if (controlClient === undefined) {
    throw new Error('Paired treatment runtime cannot resolve the shared MCP client package.');
  }
  const treatmentPackages = [
    ...agentPackages,
    controlClient,
    ...resolveBrowserIrMcpRuntimePackageInputs(),
    ...resolveBrowserIrPlaywrightRuntimePackageInputs(),
  ];
  assertExactPackageNames('control', controlPackages, PAIRED_CONTROL_RUNTIME_PACKAGE_NAMES);
  assertExactPackageNames(
    'treatment',
    treatmentPackages,
    PAIRED_TREATMENT_RUNTIME_PACKAGE_NAMES,
  );
  return collectPairedInstalledRuntimeProvenance({
    roles: {
      control: {
        packages: controlPackages,
        browser: {
          engine: 'chromium',
          executablePath: playwrightMcpChromiumExecutablePath(),
          launchVersion: probePlaywrightMcpChromiumVersion,
        },
      },
      treatment: {
        packages: treatmentPackages,
        browser: {
          engine: 'chromium',
          executablePath: browserIrPlaywrightChromiumExecutablePath(),
          launchVersion: probeBrowserIrPlaywrightChromiumVersion,
        },
      },
    },
  });
}

export function parsePairedRuntimeProvenance(input: unknown): PairedRuntimeProvenance {
  const envelope = envelopeSchema.safeParse(input);
  if (!envelope.success) {
    throw new Error(
      `Invalid paired runtime provenance: ${envelope.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  let control: InstalledRuntimeProvenance;
  let treatment: InstalledRuntimeProvenance;
  try {
    control = parseInstalledRuntimeProvenance(envelope.data.roles.control);
  } catch (error) {
    throw new Error(
      `Invalid paired runtime provenance control role: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    treatment = parseInstalledRuntimeProvenance(envelope.data.roles.treatment);
  } catch (error) {
    throw new Error(
      `Invalid paired runtime provenance treatment role: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertExactPackageNames(
    'control',
    control.packages,
    PAIRED_CONTROL_RUNTIME_PACKAGE_NAMES,
  );
  assertExactPackageNames(
    'treatment',
    treatment.packages,
    PAIRED_TREATMENT_RUNTIME_PACKAGE_NAMES,
  );
  const roles = { control, treatment };
  if (envelope.data.sha256 !== aggregateDigest(roles)) {
    throw new Error('Paired runtime provenance aggregate digest is invalid.');
  }
  return {
    schemaVersion: PAIRED_RUNTIME_PROVENANCE_SCHEMA_VERSION,
    roles,
    sha256: envelope.data.sha256,
  };
}

export function renderPairedRuntimeProvenance(input: unknown): string {
  const parsed = parsePairedRuntimeProvenance(input);
  return `${JSON.stringify(JSON.parse(stableJson(parsed)) as unknown, null, 2)}\n`;
}

export function assertPairedRuntimeProvenanceStable(
  start: PairedRuntimeProvenance,
  end: PairedRuntimeProvenance,
): void {
  const parsedStart = parsePairedRuntimeProvenance(start);
  const parsedEnd = parsePairedRuntimeProvenance(end);
  for (const role of ['control', 'treatment'] as const) {
    try {
      assertInstalledRuntimeProvenanceStable(
        parsedStart.roles[role],
        parsedEnd.roles[role],
      );
    } catch (error) {
      throw new Error(
        `Paired runtime ${role} drift: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (parsedStart.sha256 !== parsedEnd.sha256) {
    throw new Error('Paired runtime provenance aggregate changed between endpoints.');
  }
}
