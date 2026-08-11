import type { ReleaseEvidenceGate } from './record-release-evidence.mjs';

export interface ReleaseEvidenceRequirement {
  key: string;
  gate: ReleaseEvidenceGate;
  node: string;
}

export function releaseEvidenceRequirements(): ReleaseEvidenceRequirement[];

export function assembleReleaseEvidence(options: {
  inputDirectory: string;
  outputDirectory: string;
  releaseId: string;
}): Record<string, unknown>;

export function validateReleaseEvidenceDossier(directory: string): {
  report: Record<string, unknown>;
  files: Map<string, Uint8Array>;
};
