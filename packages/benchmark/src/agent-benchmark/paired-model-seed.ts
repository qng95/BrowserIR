import { createHash } from 'node:crypto';

const uint32Max = 0xffff_ffff;

/**
 * Derives the provider seed committed to one matched task/trial block.
 * Both arms share these coordinates, so arm order cannot change the seed.
 */
export function deterministicModelSeed(
  base: number,
  taskId: string,
  trialIndex: number,
): number {
  if (!Number.isInteger(base) || base < 0 || base > uint32Max) {
    throw new Error('Model seed base must be an unsigned 32-bit integer.');
  }
  if (taskId.length === 0 || taskId.includes('\0')) {
    throw new Error('Model seed taskId must be non-empty and cannot contain NUL.');
  }
  if (!Number.isSafeInteger(trialIndex) || trialIndex < 0) {
    throw new Error('Model seed trialIndex must be a non-negative safe integer.');
  }
  const hash = createHash('sha256')
    .update('browserir-paired-model-seed-v1\0', 'utf8')
    .update(String(base), 'utf8')
    .update('\0', 'utf8')
    .update(taskId, 'utf8')
    .update('\0', 'utf8')
    .update(String(trialIndex), 'utf8')
    .digest();
  return hash.readUInt32BE(0);
}
