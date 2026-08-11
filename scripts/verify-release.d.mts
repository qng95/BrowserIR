export interface ReleaseReadinessOptions {
  root?: string;
  packageDirectories?: readonly string[];
  inspectPackedArtifacts?: boolean;
}

export declare function releaseReadinessFailures(
  options?: ReleaseReadinessOptions,
): string[];
