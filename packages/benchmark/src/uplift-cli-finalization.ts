import {
  assertSealedGitSourceStable,
  type PairedBenchmarkPhase,
  type SealedGitSourceSnapshot,
} from './agent-benchmark/index.js';

export interface PairedUpliftSourceState extends SealedGitSourceSnapshot {
  freezeRef?: string | undefined;
}

export interface CapturedPairedUpliftSourceState extends PairedUpliftSourceState {
  protocolBinding: 'development' | 'frozen_verified';
}

export interface FinalizedPairedUpliftEvidence<BuildEnd, EnvironmentEnd> {
  sourceEnd: PairedUpliftSourceState;
  buildEnd?: BuildEnd | undefined;
  environmentEnd: EnvironmentEnd;
}

export interface FinalizePairedUpliftEvidenceOptions<BuildStart, BuildEnd, EnvironmentEnd> {
  phase: PairedBenchmarkPhase;
  protocolBinding: 'development' | 'frozen_verified';
  sourceStart: PairedUpliftSourceState;
  buildStart?: BuildStart | undefined;
  captureSourceEnd: () => Promise<CapturedPairedUpliftSourceState>;
  captureBuildEnd?: ((start: BuildStart) => Promise<BuildEnd>) | undefined;
  captureEnvironmentEnd: () => Promise<EnvironmentEnd>;
  writeArtifacts: (
    evidence: FinalizedPairedUpliftEvidence<BuildEnd, EnvironmentEnd>,
  ) => Promise<void>;
  createCompletion: () => Promise<void>;
}

/**
 * The only finalization order permitted by the uplift CLI. Drift aborts before
 * score artifacts, and COMPLETE is exposed only after every endpoint capture
 * and artifact write succeeds.
 */
export async function finalizePairedUpliftEvidence<
  BuildStart,
  BuildEnd,
  EnvironmentEnd,
>(
  options: FinalizePairedUpliftEvidenceOptions<BuildStart, BuildEnd, EnvironmentEnd>,
): Promise<FinalizedPairedUpliftEvidence<BuildEnd, EnvironmentEnd>> {
  const { protocolBinding: endProtocolBinding, ...sourceEnd } =
    await options.captureSourceEnd();
  if (endProtocolBinding !== options.protocolBinding) {
    throw new Error('Protocol source binding changed between execution start and end.');
  }

  let buildEnd: BuildEnd | undefined;
  if (options.phase === 'sealed') {
    assertSealedGitSourceStable(options.sourceStart, sourceEnd);
    if (options.buildStart === undefined || options.captureBuildEnd === undefined) {
      throw new Error('Sealed execution is missing its retained build provenance lifecycle.');
    }
    buildEnd = await options.captureBuildEnd(options.buildStart);
  }

  const environmentEnd = await options.captureEnvironmentEnd();
  const evidence: FinalizedPairedUpliftEvidence<BuildEnd, EnvironmentEnd> = {
    sourceEnd,
    ...(buildEnd === undefined ? {} : { buildEnd }),
    environmentEnd,
  };
  await options.writeArtifacts(evidence);
  await options.createCompletion();
  return evidence;
}
