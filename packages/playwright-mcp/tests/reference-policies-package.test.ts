import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packedVmFixture = fileURLToPath(
  new URL('./fixtures/packed-vm-cross-realm.mjs', import.meta.url),
);
const temporaryRoot = mkdtempSync(join(tmpdir(), 'browserir-reference-policy-pack-'));
const extractedRoot = join(temporaryRoot, 'extracted');
let archive = '';
let packedPaths: readonly string[] = [];

const packedSnapshot = (tree: string) => ({
  content: [{
    type: 'text' as const,
    text: [
      '### Page state',
      '- Page URL: https://fixture.test/packed-proxy',
      '',
      '### Snapshot',
      '```yaml',
      tree.trim(),
      '```',
    ].join('\n'),
  }],
});

const packedGridBaseline = `
- grid "Matrix" [ref=e1]
  - row [ref=e2]
    - columnheader "January" [ref=e3]
    - columnheader "February" [ref=e4]
  - row [ref=e5]
    - rowheader "North" [ref=e6]
  - row [ref=e7]
    - rowheader "South" [ref=e8]
- button "Apply" [ref=e9]
- button "Apply" [ref=e10]
- button "Apply" [ref=e11]
- button "Apply" [ref=e12]
`;

const packedGridBoxed = `
- grid "Matrix" [ref=e101] [box=0,0,300,250]
  - row [ref=e102] [box=0,0,300,50]
    - columnheader "January" [ref=e103] [box=100,0,100,50]
    - columnheader "February" [ref=e104] [box=200,0,100,50]
  - row [ref=e105] [box=0,50,300,100]
    - rowheader "North" [ref=e106] [box=0,50,100,100]
  - row [ref=e107] [box=0,150,300,100]
    - rowheader "South" [ref=e108] [box=0,150,100,100]
- button "Apply" [ref=e21] [box=110,75,80,50]
- button "Apply" [ref=e22] [box=210,75,80,50]
- button "Apply" [ref=e23] [box=110,175,80,50]
- button "Apply" [ref=e24] [box=210,175,80,50]
`;

beforeAll(() => {
  execFileSync('pnpm', ['build'], {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 120_000,
  });
  const output = execFileSync(
    'pnpm',
    ['--config.ignore-scripts=true', 'pack', '--pack-destination', temporaryRoot, '--json'],
    {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 120_000,
    },
  );
  const parsed = JSON.parse(output.trim()) as { filename?: string };
  const candidates = readdirSync(temporaryRoot).filter((entry) => entry.endsWith('.tgz'));
  archive = parsed.filename === undefined
    ? join(temporaryRoot, candidates[0]!)
    : join(temporaryRoot, basename(parsed.filename));
  packedPaths = execFileSync('tar', ['-tf', archive], {
    encoding: 'utf8',
    stdio: 'pipe',
  }).split('\n').filter(Boolean);
  mkdirSync(extractedRoot);
  execFileSync('tar', ['-xzf', archive, '-C', extractedRoot], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
}, 120_000);

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('packed reference-policy boundary', () => {
  it('keeps the package private and exposes policies only through the explicit subpath', async () => {
    const manifest = JSON.parse(readFileSync(join(extractedRoot, 'package/package.json'), 'utf8')) as {
      private?: boolean;
      exports?: Record<string, unknown>;
      dependencies?: Record<string, string>;
    };
    expect(manifest.private).toBe(true);
    expect(manifest.exports).toEqual({
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
        default: './dist/index.js',
      },
      './reference-policies': {
        types: './dist/reference-policies.d.ts',
        import: './dist/reference-policies.js',
        default: './dist/reference-policies.js',
      },
      './package.json': './package.json',
    });
    expect(manifest.dependencies).toEqual({ '@modelcontextprotocol/client': '2.0.0' });

    const main = await import(pathToFileURL(join(extractedRoot, 'package/dist/index.js')).href);
    const policies = await import(
      pathToFileURL(join(extractedRoot, 'package/dist/reference-policies.js')).href
    );
    expect(main).not.toHaveProperty('createGridCoordinateReferencePolicy');
    expect(main).not.toHaveProperty('createScheduleCoordinateReferencePolicy');
    expect(main).not.toHaveProperty('createCrossTreeLabelReferencePolicy');
    expect(typeof policies.createGridCoordinateReferencePolicy).toBe('function');
    expect(typeof policies.createScheduleCoordinateReferencePolicy).toBe('function');
    expect(typeof policies.createCrossTreeLabelReferencePolicy).toBe('function');
  });

  it('contains deterministic build outputs but no source, tests, or benchmark code', () => {
    expect(packedPaths).toContain('package/dist/reference-policies.js');
    expect(packedPaths).toContain('package/dist/reference-policies.d.ts');
    expect(packedPaths.some((entry) => entry.includes('/src/'))).toBe(false);
    expect(packedPaths.some((entry) => entry.includes('/tests/'))).toBe(false);
    expect(packedPaths.some((entry) => entry.toLocaleLowerCase('en-US').includes('benchmark')))
      .toBe(false);
    for (const entry of packedPaths.filter((path) => path.endsWith('.js'))) {
      const source = execFileSync('tar', ['-xOf', archive, entry], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      expect(source).not.toMatch(/(?:from|import\()\s*['"][^'"]*benchmark/iu);
    }
  });

  it('admits a host-realm frozen snapshot through exact packed JavaScript in an isolated VM', () => {
    const output = execFileSync(
      process.execPath,
      ['--experimental-vm-modules', packedVmFixture, archive],
      {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 120_000,
      },
    );

    expect(JSON.parse(output)).toEqual({
      operation: 'snapshot',
      outcome: 'projected',
      hiddenCalls: 1,
      rawCallCount: 2,
      visibleRequestIdentity: true,
    });
  });

  it('rejects request and argument Proxies on built package bytes before hidden acquisition', async () => {
    const main = await import(pathToFileURL(join(extractedRoot, 'package/dist/index.js')).href) as {
      createAdaptivePlaywrightTools: (
        client: {
          callTool(request: unknown): Promise<unknown>;
          listTools(): Promise<{ tools: readonly unknown[] }>;
        },
        options: { mode: 'auto'; policySet: object },
      ) => {
        callTool(request: unknown): Promise<unknown>;
        dispose(): Promise<void>;
      };
    };
    const policies = await import(
      pathToFileURL(join(extractedRoot, 'package/dist/reference-policies.js')).href
    ) as { createGridCoordinateReferencePolicy(): object };

    for (const target of ['request', 'arguments'] as const) {
      const visible = packedSnapshot(packedGridBaseline);
      const hidden = packedSnapshot(packedGridBoxed);
      const seenNames: unknown[] = [];
      let calls = 0;
      let requestProxyTraps = 0;
      let argumentsProxyTraps = 0;
      const proxiedArguments = new Proxy({}, {
        getPrototypeOf() {
          argumentsProxyTraps += 1;
          return Object.prototype;
        },
        ownKeys() {
          argumentsProxyTraps += 1;
          return [];
        },
        getOwnPropertyDescriptor() {
          argumentsProxyTraps += 1;
          return undefined;
        },
        isExtensible() {
          argumentsProxyTraps += 1;
          return true;
        },
      });
      const requestTarget = {
        name: 'browser_snapshot',
        arguments: target === 'arguments' ? proxiedArguments : {},
      };
      const request = target === 'request'
        ? new Proxy(requestTarget, {
            getPrototypeOf(value) {
              requestProxyTraps += 1;
              return Reflect.getPrototypeOf(value);
            },
            get(value, key, receiver) {
              requestProxyTraps += 1;
              if (key === 'name') return 'browser_click';
              return Reflect.get(value, key, receiver);
            },
          })
        : requestTarget;
      const client = {
        async callTool(rawRequest: unknown) {
          calls += 1;
          seenNames.push((rawRequest as { name?: unknown }).name);
          return calls === 1 ? visible : hidden;
        },
        async listTools() {
          return { tools: [] };
        },
      };
      const tools = main.createAdaptivePlaywrightTools(client, {
        mode: 'auto',
        policySet: policies.createGridCoordinateReferencePolicy(),
      });

      await expect(tools.callTool(request)).resolves.toBe(visible);
      expect(calls).toBe(1);
      expect(seenNames).toEqual([
        target === 'request' ? 'browser_click' : 'browser_snapshot',
      ]);
      expect(requestProxyTraps).toBe(target === 'request' ? 1 : 0);
      expect(argumentsProxyTraps).toBe(0);
      await tools.dispose();
    }
  });
});
