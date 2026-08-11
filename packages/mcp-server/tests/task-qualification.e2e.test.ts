import { TASKS } from '@think-dom/fixture-app';
import { describe, expect, it } from 'vitest';

import { qualifyFixtureTask, type FixtureTaskQualificationResult } from './task-qualification-harness.js';

const requestedTask = process.env['BROWSERIR_QUALIFICATION_TASK'];
const enabled = process.env['BROWSERIR_RUN_TASK_QUALIFICATION'] === '1' || requestedTask !== undefined;
const selectedTasks = requestedTask === undefined
  ? TASKS
  : TASKS.filter((task) => task.id === requestedTask);

if (requestedTask !== undefined && selectedTasks.length === 0) {
  throw new Error(`Unknown BROWSERIR_QUALIFICATION_TASK: ${requestedTask}`);
}

const failureReport = (result: FixtureTaskQualificationResult): string =>
  JSON.stringify(
    {
      task_id: result.taskId,
      outcome: result.outcome,
      reason: result.reason,
      planner_error: result.plannerError,
      isolation: result.isolation,
      diagnostics: result.diagnostics,
    },
    null,
    2,
  );

const suite = enabled ? describe.sequential : describe.skip;
suite('official MCP client fixture-task qualification', () => {
  for (const task of selectedTasks) {
    it(
      task.id,
      async () => {
        const result = await qualifyFixtureTask(task.id);
        console.info(
          JSON.stringify({
            task_id: result.taskId,
            outcome: result.outcome,
            reason: result.reason,
            duration_ms: result.durationMs,
            actions: result.diagnostics.length,
          }),
        );
        expect(result.outcome, failureReport(result)).toBe('passed');
      },
      120_000,
    );
  }
});
