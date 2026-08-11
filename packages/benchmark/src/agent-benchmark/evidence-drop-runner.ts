import { createHash } from 'node:crypto';

import { stableJson } from '../environment.js';
import type {
  AgentBenchmarkTask,
  AgentToolDescriptor,
  AgentTrialTarget,
  DeterministicJudgeResult,
} from './contracts.js';
import { createSubmissionBroker } from './submission-broker.js';

export interface ModelFacingCatalogSnapshot {
  catalog: readonly AgentToolDescriptor[];
  sha256: string;
  toolCount: number;
  targetVersion: string;
  baseline: DeterministicJudgeResult;
}

export function modelFacingToolCatalogSha256(
  catalog: readonly AgentToolDescriptor[],
): string {
  const names = new Set<string>();
  for (const tool of catalog) {
    if (names.has(tool.name)) {
      throw new Error(`Duplicate model-facing tool name: ${tool.name}`);
    }
    names.add(tool.name);
  }
  return createHash('sha256').update(stableJson(catalog), 'utf8').digest('hex');
}

/**
 * Inspect the exact catalog visible to the model, including the trusted benchmark
 * submission tool. This never invokes a model or browser action.
 */
export async function inspectModelFacingCatalog(input: {
  task: AgentBenchmarkTask;
  trialIndex?: number | undefined;
  targetFactory(task: AgentBenchmarkTask, trialIndex: number): Promise<AgentTrialTarget>;
}): Promise<ModelFacingCatalogSnapshot> {
  const target = await input.targetFactory(input.task, input.trialIndex ?? 0);
  const submission = createSubmissionBroker(target.tools, target.submission);
  try {
    const baseline = await target.judge({
      phase: 'baseline',
      submissionAttempts: 0,
      submitted: false,
    });
    if (baseline.outcome !== 'failed') {
      throw new Error(
        `Catalog preflight requires a failing baseline; received ${baseline.outcome}.`,
      );
    }
    const catalog = await submission.broker.listTools();
    return {
      catalog,
      sha256: modelFacingToolCatalogSha256(catalog),
      toolCount: catalog.length,
      targetVersion: target.targetVersion,
      baseline,
    };
  } finally {
    await submission.broker.close().catch(() => {});
    await target.stopAgentAccess().catch(() => {});
    await target.dispose().catch(() => {});
  }
}
