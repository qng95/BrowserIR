import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, parse } from 'node:path';

const brokerRequire = createRequire(new URL('./mcp-broker.js', import.meta.url));
const mcpManifestPath = brokerRequire.resolve('@browserir/mcp/package.json');
const mcpRequire = createRequire(mcpManifestPath);

export const BROWSERIR_MCP_RUNTIME_PACKAGE_NAMES = [
  '@modelcontextprotocol/server',
] as const;

export interface BrowserIrMcpRuntimePackageInput {
  name: (typeof BROWSERIR_MCP_RUNTIME_PACKAGE_NAMES)[number];
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

/** Resolve the server package loaded through BrowserIR MCP's actual import boundary. */
export function resolveBrowserIrMcpRuntimePackageInputs(): BrowserIrMcpRuntimePackageInput[] {
  return [
    {
      name: '@modelcontextprotocol/server',
      packageDirectory: packageDirectoryFromEntry(
        mcpRequire.resolve('@modelcontextprotocol/server'),
        '@modelcontextprotocol/server',
      ),
    },
  ];
}
