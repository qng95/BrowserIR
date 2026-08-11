import { describe, expect, it, vi } from 'vitest';

import { finalizePairedUpliftEvidence } from '../src/uplift-cli-finalization.js';

const source = {
  revision: '1'.repeat(40),
  tree: '2'.repeat(40),
  clean: true,
  freezeRef: 'refs/tags/evidence-drop-01-protocol-v1',
};

describe('paired uplift CLI finalization orchestration', () => {
  it('recaptures sealed source, build, and environment before artifacts and COMPLETE', async () => {
    const order: string[] = [];
    const writeArtifacts = vi.fn(async (evidence: unknown) => {
      order.push('artifacts');
      expect(evidence).toMatchObject({
        sourceEnd: source,
        buildEnd: { end: { sha256: 'b'.repeat(64) } },
        environmentEnd: { binding: { bindingSha256: 'e'.repeat(64) } },
      });
    });

    await finalizePairedUpliftEvidence({
      phase: 'sealed',
      protocolBinding: 'frozen_verified',
      sourceStart: source,
      buildStart: { sha256: 'a'.repeat(64) },
      async captureSourceEnd() {
        order.push('source');
        return { ...source, protocolBinding: 'frozen_verified' };
      },
      async captureBuildEnd(start) {
        order.push('build');
        expect(start).toEqual({ sha256: 'a'.repeat(64) });
        return { end: { sha256: 'b'.repeat(64) } };
      },
      async captureEnvironmentEnd() {
        order.push('environment');
        return { binding: { bindingSha256: 'e'.repeat(64) } };
      },
      writeArtifacts,
      async createCompletion() {
        order.push('complete');
      },
    });

    expect(order).toEqual(['source', 'build', 'environment', 'artifacts', 'complete']);
    expect(writeArtifacts).toHaveBeenCalledOnce();
  });

  it.each(['source', 'build'] as const)(
    'fails closed on sealed %s drift before artifacts or COMPLETE',
    async (failure) => {
      const writeArtifacts = vi.fn(async () => {});
      const createCompletion = vi.fn(async () => {});
      await expect(
        finalizePairedUpliftEvidence({
          phase: 'sealed',
          protocolBinding: 'frozen_verified',
          sourceStart: source,
          buildStart: { sha256: 'a'.repeat(64) },
          async captureSourceEnd() {
            return {
              ...source,
              revision: failure === 'source' ? '3'.repeat(40) : source.revision,
              protocolBinding: 'frozen_verified' as const,
            };
          },
          async captureBuildEnd() {
            if (failure === 'build') throw new Error('build provenance drift');
            return { end: { sha256: 'a'.repeat(64) } };
          },
          async captureEnvironmentEnd() {
            return { binding: { bindingSha256: 'e'.repeat(64) } };
          },
          writeArtifacts,
          createCompletion,
        }),
      ).rejects.toThrow(/source revision drift|build provenance drift/i);
      expect(writeArtifacts).not.toHaveBeenCalled();
      expect(createCompletion).not.toHaveBeenCalled();
    },
  );
});
