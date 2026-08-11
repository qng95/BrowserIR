export type ReleaseEvidenceGate =
  | 'workspace-verification'
  | 'capability-qualification'
  | 'task-qualification'
  | 'representation-qualification'
  | 'performance-characterization'
  | 'packed-consumer'
  | 'production-audit';

export interface ReleaseEvidenceArguments {
  gate: ReleaseEvidenceGate;
  outputDirectory: string;
  runId: string;
  skipBuild: boolean;
}

export interface JunitSummary {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  timeSeconds: number;
}

export interface NormalizedPnpmAuditReport {
  vulnerabilities: {
    info: number;
    low: number;
    moderate: number;
    high: number;
    critical: number;
  };
  totalVulnerabilities: number;
  dependencies: {
    production: number;
    development: number;
    optional: number;
    total: number;
  };
}

export interface EvidenceArtifactRecord {
  name: string;
  bytes: number;
  sha256: string;
}

export const releaseEvidenceSourceFilePaths: readonly string[];
export const releaseEvidenceSchemaVersion: '1.1.0';

export function parseReleaseEvidenceArguments(arguments_: string[]): ReleaseEvidenceArguments;
export function vitestEvidenceArguments(options: {
  targets?: string[];
  jsonPath: string;
  junitPath: string;
}): string[];
export function reportArtifactsForGate(gate: ReleaseEvidenceGate): string[];
export function classifySourceBinding(source: {
  revision: string;
  tree: string;
  objectFormat: string;
  dirty: boolean;
  githubSha?: string;
}): { status: 'bound' | 'unbound'; reasons: string[] };
export function verifyStableEvidenceSource(options: {
  gateOutcome: 'passed' | 'failed';
  sourceBefore: Record<string, unknown>;
  sourceAfter: Record<string, unknown>;
}): {
  outcome: 'passed' | 'failed';
  source: Record<string, unknown>;
  verification: {
    status: 'stable' | 'changed';
    changedFields: string[];
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  };
};
export function parseJunitSummary(xml: string): JunitSummary;
export function normalizePnpmAuditReport(report: unknown): NormalizedPnpmAuditReport;
export function classifyPnpmAuditOutcome(options: {
  exitCode: number | null;
  normalized?: NormalizedPnpmAuditReport;
  muted?: number;
}): 'passed' | 'vulnerabilities_found' | 'audit_unavailable';
export function finalizeEvidenceDirectory(options: {
  targetDirectory: string;
  artifacts: Map<string, string | Uint8Array>;
}): EvidenceArtifactRecord[];
