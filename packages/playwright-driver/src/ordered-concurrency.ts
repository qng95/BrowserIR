export async function mapOrderedConcurrent<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  worker: (input: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be a positive integer');
  }

  const results = new Array<Output>(inputs.length);
  let nextIndex = 0;
  let failed = false;
  let firstFailure: unknown;

  const run = async (): Promise<void> => {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= inputs.length) return;

      try {
        results[index] = await worker(inputs[index]!, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstFailure = error;
        }
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, () => run()),
  );
  if (failed) throw firstFailure;
  return results;
}
