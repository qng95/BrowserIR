import { qualifyFixtureTask } from './task-qualification-harness.js';

async function main(): Promise<void> {
  const taskId = process.argv[2];
  if (taskId === undefined || taskId === '') throw new Error('Qualification worker requires a task ID.');
  const result = await qualifyFixtureTask(taskId);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `BrowserIR qualification worker failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
