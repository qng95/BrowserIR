import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  modelFacingToolCatalogSha256,
  readControlCapabilityProtocol,
  type AgentToolDescriptor,
} from '../src/agent-benchmark/index.js';

const manifestPath = fileURLToPath(
  new URL('../../../docs/evidence-drops/drop-01/control-capability-v1.protocol.json', import.meta.url),
);
const retainedRunUrl = new URL(
  '../../../docs/evidence-drops/drop-01/control-capability-qwen38max-v1-run/',
  import.meta.url,
);

const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

describe('frozen control capability manifest', () => {
  it('binds the byte-frozen manifest to its complete retained historical evidence', async () => {
    const manifest = await readControlCapabilityProtocol(manifestPath);
    const [
      archivedProtocolSource,
      catalogSource,
      reportSource,
      sourceStart,
      sourceEnd,
      systemPromptSource,
      checksumsSource,
    ] = await Promise.all([
      readFile(fileURLToPath(new URL('protocol.json', retainedRunUrl)), 'utf8'),
      readFile(fileURLToPath(new URL('control-tool-catalog.json', retainedRunUrl)), 'utf8'),
      readFile(fileURLToPath(new URL('control-capability.json', retainedRunUrl)), 'utf8'),
      readFile(fileURLToPath(new URL('source-start.json', retainedRunUrl)), 'utf8'),
      readFile(fileURLToPath(new URL('source-end.json', retainedRunUrl)), 'utf8'),
      readFile(fileURLToPath(new URL('system-prompt.txt', retainedRunUrl)), 'utf8'),
      readFile(fileURLToPath(new URL('SHA256SUMS', retainedRunUrl)), 'utf8'),
    ]);
    const catalog = JSON.parse(catalogSource) as AgentToolDescriptor[];
    const report = JSON.parse(reportSource) as {
      attempts: Array<{
        targetVersion: string;
        taskId: string;
        taskVersion: string;
        tools: { toolCatalogSha256: string };
      }>;
      binding: Record<string, unknown>;
      protocolId: string;
      protocolSha256: string;
      purpose: string;
      result: {
        completedAttempts: number;
        failed: number;
        invalid: number;
        passed: number;
        scheduledAttempts: number;
        status: string;
      };
      scoreEligible: boolean;
    };
    const source = JSON.parse(sourceStart) as {
      clean: boolean;
      revision: string;
      tree: string;
    };
    const { systemPrompt: _systemPrompt, ...agentBinding } = manifest.protocol.agent;

    expect(manifest.sha256).toBe(
      'b6a37c28474a3204cdf9a8702c311d95d5caea1b7a7b50461777b36c987faebe',
    );
    expect(archivedProtocolSource).toBe(manifest.sourceText);
    expect(systemPromptSource).toBe(`${manifest.protocol.agent.systemPrompt}\n`);
    expect(modelFacingToolCatalogSha256(catalog)).toBe(
      manifest.protocol.control.expectedToolCatalogSha256,
    );
    expect(sourceEnd).toBe(sourceStart);
    expect(source).toMatchObject({
      clean: true,
      revision: '6a122a2bfd0c1f684e1eec350659db3c7d1eadeb',
      tree: '3ca4a038b52f511088c13655d4d4ff8a547641f0',
    });
    expect(report).toMatchObject({
      protocolId: manifest.protocol.protocolId,
      protocolSha256: manifest.sha256,
      purpose: manifest.protocol.purpose,
      scoreEligible: false,
      result: {
        completedAttempts: 5,
        failed: 0,
        invalid: 0,
        passed: 5,
        scheduledAttempts: 5,
        status: 'demonstrated',
      },
    });
    expect(report.binding).toEqual({
      agent: agentBinding,
      budgets: manifest.protocol.budgets,
      control: manifest.protocol.control,
      decisionRule: manifest.protocol.decisionRule,
      schedule: manifest.protocol.schedule,
      target: manifest.protocol.target,
      task: manifest.protocol.task,
    });
    expect(report.attempts).toHaveLength(5);
    for (const attempt of report.attempts) {
      expect(attempt).toMatchObject({
        targetVersion: manifest.protocol.target.expectedVersion,
        taskId: manifest.protocol.task.id,
        taskVersion: manifest.protocol.task.version,
        tools: {
          toolCatalogSha256: manifest.protocol.control.expectedToolCatalogSha256,
        },
      });
    }

    expect(sha256(checksumsSource)).toBe(
      '35457e6cc2846c4b57e1392df0bcd68982d4369ad017058b9c7eef35653561f6',
    );
    const checksumEntries = checksumsSource.trimEnd().split('\n').map((line) => {
      const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
      if (match?.[1] === undefined || match[2] === undefined) {
        throw new Error(`Invalid retained checksum line: ${line}`);
      }
      return { digest: match[1], name: match[2] };
    });
    expect((await readdir(fileURLToPath(retainedRunUrl))).sort()).toEqual(
      ['SHA256SUMS', ...checksumEntries.map(({ name }) => name)].sort(),
    );
    for (const entry of checksumEntries) {
      const bytes = await readFile(fileURLToPath(new URL(entry.name, retainedRunUrl)));
      expect(sha256(bytes), entry.name).toBe(entry.digest);
    }
  });
});
