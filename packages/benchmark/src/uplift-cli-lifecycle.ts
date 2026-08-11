import { isAbsolute } from 'node:path';

import type {
  PairedAgentBenchmarkCompletionMarker,
  PairedBenchmarkPhase,
  ReconstructedPairedRun,
} from './agent-benchmark/index.js';

export type PairedUpliftResumeMode = 'continue' | 'finalize_only';

export interface ClassifyPairedUpliftResumeInput {
  retained: ReconstructedPairedRun;
  completion?: PairedAgentBenchmarkCompletionMarker | undefined;
  phase: PairedBenchmarkPhase;
  protocolId: string;
  protocolSha256: string;
}

export interface PairedUpliftResumeDisposition {
  mode: PairedUpliftResumeMode;
  runId: string;
}

export interface PairedUpliftSourceBindingInput {
  phase: 'development' | 'sealed';
  freezeRef?: string | undefined;
  clean: boolean;
  revision: string | null;
  tree: string | null;
  frozenRevision?: string | undefined;
  manifestRelativePath?: string | undefined;
  manifestSource: string;
  committedManifestSource?: string | undefined;
}

/** Pure fail-closed source gate shared by sealed CLI execution and tests. */
export function assertPairedUpliftSourceBinding(
  input: PairedUpliftSourceBindingInput,
): 'development' | 'frozen_verified' {
  if (input.phase !== 'sealed') return 'development';
  if (input.freezeRef === undefined) {
    throw new Error('Sealed protocol is missing its freezeRef.');
  }
  if (!input.clean) throw new Error('Sealed evidence requires a clean Git worktree.');
  if (input.revision === null || input.tree === null) {
    throw new Error('Sealed evidence requires a resolved Git HEAD and tree.');
  }
  if (input.frozenRevision !== input.revision) {
    throw new Error(
      `Freeze ref ${input.freezeRef} does not resolve to current HEAD ${input.revision}.`,
    );
  }
  const manifestRelativePath = input.manifestRelativePath;
  if (
    manifestRelativePath === undefined ||
    manifestRelativePath.length === 0 ||
    isAbsolute(manifestRelativePath) ||
    manifestRelativePath === '..' ||
    manifestRelativePath.startsWith('../') ||
    manifestRelativePath.startsWith('..\\')
  ) {
    throw new Error('Sealed protocol manifest must be inside the workspace.');
  }
  if (input.committedManifestSource !== input.manifestSource) {
    throw new Error('Protocol manifest bytes differ from the frozen Git revision.');
  }
  return 'frozen_verified';
}

/**
 * Pure CLI lifecycle gate applied immediately after retained evidence is read.
 * A complete journal without COMPLETE.json is finalization work, not a new
 * scored run. A valid COMPLETE.json permanently closes the evidence directory.
 */
export function classifyPairedUpliftResume(
  input: ClassifyPairedUpliftResumeInput,
): PairedUpliftResumeDisposition {
  const { retained, completion } = input;
  if (retained.run.phase !== input.phase) {
    throw new Error('Resume journal phase drifted from the selected manifest.');
  }
  if (
    retained.run.protocolId !== input.protocolId ||
    retained.run.protocolSha256 !== input.protocolSha256
  ) {
    throw new Error('Resume journal protocol identity drifted from the selected manifest.');
  }
  if (completion !== undefined) {
    if (!retained.complete) {
      throw new Error('Completion marker is attached to an incomplete paired journal.');
    }
    const finalEventSha256 = retained.events.at(-1)?.eventSha256;
    if (
      completion.runId !== retained.run.runId ||
      completion.protocolId !== input.protocolId ||
      completion.protocolSha256 !== input.protocolSha256 ||
      completion.journalFinalEventSha256 !== finalEventSha256
    ) {
      throw new Error('Completion marker drifted from the retained journal or protocol.');
    }
    throw new Error(
      `Paired benchmark evidence ${retained.run.runId} is already finalized by COMPLETE.json.`,
    );
  }
  return {
    mode: retained.complete ? 'finalize_only' : 'continue',
    runId: retained.run.runId,
  };
}
