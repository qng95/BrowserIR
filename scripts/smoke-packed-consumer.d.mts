export interface PackedArtifactRecord {
  file: string;
  name: string;
  bytes: number;
  sha256: string;
}

export declare function parsePackedConsumerArguments(arguments_: string[]): {
  artifactDirectory?: string;
  releaseEvidenceDirectory?: string;
  reportPath?: string;
};

export declare function writePackedConsumerReport(
  reportPath: string,
  report: Record<string, unknown>,
): void;

export declare function writeConsumerSources(
  consumerDirectory: string,
  executablePath: string,
  packageVersion: string,
  expectedDependencyVersions: Record<string, string>,
): void;

export declare function validateArtifactDirectory(artifactDirectory: string): void;

export declare function validateReleaseEvidenceForWorkspace(options: {
  releaseEvidenceDirectory: string;
  workspaceDirectory?: string;
}): {
  report: Record<string, unknown>;
  files: Map<string, Uint8Array>;
};

export declare function finalizeReleaseArtifacts(options: {
  artifactDirectory: string;
  archives: ReadonlyMap<string, string>;
  releaseEvidenceDirectory: string;
  workspaceDirectory?: string;
}): PackedArtifactRecord[];

export declare function smokePackedConsumer(options?: {
  artifactDirectory?: string;
  releaseEvidenceDirectory?: string;
  reportPath?: string;
}): Record<string, unknown>;
