import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, parse } from 'node:path';

const agentRequire = createRequire(
  new URL('../control-capability-agent.ts', import.meta.url),
);
const langChainOpenAiManifestPath = agentRequire.resolve('@langchain/openai/package.json');
const langChainOpenAiRequire = createRequire(langChainOpenAiManifestPath);

export const CONTROL_CAPABILITY_AGENT_RUNTIME_PACKAGE_NAMES = [
  '@langchain/core',
  '@langchain/openai',
  'langchain',
  'openai',
] as const;

export interface ControlCapabilityAgentRuntimePackageInput {
  name: (typeof CONTROL_CAPABILITY_AGENT_RUNTIME_PACKAGE_NAMES)[number];
  packageDirectory: string;
}

function packageDirectoryFromEntry(entryPath: string, expectedName: string): string {
  const root = parse(entryPath).root;
  let directory = dirname(entryPath);
  while (directory !== root) {
    const manifestPath = join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
      } catch {
        throw new Error(`Runtime package manifest is invalid JSON for ${expectedName}.`);
      }
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>)['name'] === expectedName
      ) {
        return directory;
      }
    }
    directory = dirname(directory);
  }
  throw new Error(`Cannot resolve the runtime package root for ${expectedName}.`);
}

/** Resolve the packages loaded by control-capability-agent and its OpenAI adapter. */
export function resolveControlCapabilityAgentRuntimePackageInputs(): ControlCapabilityAgentRuntimePackageInput[] {
  return [
    {
      name: '@langchain/core',
      packageDirectory: dirname(agentRequire.resolve('@langchain/core/package.json')),
    },
    {
      name: '@langchain/openai',
      packageDirectory: dirname(langChainOpenAiManifestPath),
    },
    {
      name: 'langchain',
      packageDirectory: dirname(agentRequire.resolve('langchain/package.json')),
    },
    {
      name: 'openai',
      packageDirectory: packageDirectoryFromEntry(
        langChainOpenAiRequire.resolve('openai'),
        'openai',
      ),
    },
  ];
}
