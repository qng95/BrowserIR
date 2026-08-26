import { execFileSync } from 'node:child_process';
import { posix as path } from 'node:path';
import { performance as hostPerformance } from 'node:perf_hooks';
import { TextEncoder as HostTextEncoder, types as hostUtilTypes } from 'node:util';
import * as nodeVm from 'node:vm';

const archive = process.argv[2];
if (archive === undefined) throw new Error('Packed archive path is required.');
if (
  typeof nodeVm.SourceTextModule !== 'function' ||
  typeof nodeVm.SyntheticModule !== 'function'
) throw new Error('VM module support is unavailable.');

const paths = execFileSync('tar', ['-tf', archive], {
  encoding: 'utf8',
  stdio: 'pipe',
}).split('\n').filter((entry) => entry.startsWith('package/dist/') && entry.endsWith('.js'));
const sources = new Map(paths.map((entry) => [
  entry,
  execFileSync('tar', ['-xOf', archive, entry], { encoding: 'utf8', stdio: 'pipe' }),
]));
if (!sources.has('package/dist/index.js') || !sources.has('package/dist/reference-policies.js')) {
  throw new Error('Packed JavaScript entrypoints are missing.');
}

const sandbox = Object.create(null);
Object.defineProperties(sandbox, {
  AbortSignal: {
    value: AbortSignal, configurable: false, enumerable: true, writable: false,
  },
  TextEncoder: {
    value: HostTextEncoder, configurable: false, enumerable: true, writable: false,
  },
  performance: {
    value: hostPerformance, configurable: false, enumerable: true, writable: false,
  },
});
const context = nodeVm.createContext(sandbox, {
  name: 'browserir-packed-cross-realm-test',
  codeGeneration: { strings: false, wasm: false },
});
const safeUtilTypes = Object.freeze(Object.assign(Object.create(null), {
  isProxy: hostUtilTypes.isProxy,
}));
const utilModule = new nodeVm.SyntheticModule(['types'], function initialize() {
  this.setExport('types', safeUtilTypes);
}, { context, identifier: 'node:util' });
const modules = new Map();

const load = (identifier) => {
  const retained = modules.get(identifier);
  if (retained !== undefined) return retained;
  const source = sources.get(identifier);
  if (source === undefined) throw new Error(`Unverified packed module: ${identifier}.`);
  const module = new nodeVm.SourceTextModule(source, { context, identifier });
  modules.set(identifier, module);
  return module;
};

const harness = new nodeVm.SourceTextModule(`
  export { createAdaptivePlaywrightTools } from './index.js';
  export { createGridCoordinateReferencePolicy } from './reference-policies.js';
`, { context, identifier: 'package/dist/__cross_realm_harness__.js' });
await harness.link((specifier, referencingModule) => {
  if (specifier === 'node:util') return utilModule;
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    throw new Error(`Forbidden packed import: ${specifier}.`);
  }
  const resolved = path.normalize(path.join(path.dirname(referencingModule.identifier), specifier));
  if (!resolved.startsWith('package/dist/')) {
    throw new Error(`Packed import escaped dist: ${specifier}.`);
  }
  return load(resolved);
});
await harness.evaluate();

const snapshot = (tree) => ({
  content: [{
    type: 'text',
    text: [
      '### Page state',
      '- Page URL: https://fixture.test/packed-cross-realm',
      '',
      '### Snapshot',
      '```yaml',
      tree.trim(),
      '```',
    ].join('\n'),
  }],
});
const visible = snapshot(`
- grid "Matrix" [ref=e1]:
  - row [ref=e2]:
    - columnheader "January" [ref=e3]
    - columnheader "February" [ref=e4]
  - row [ref=e5]:
    - rowheader "North" [ref=e6]
  - row [ref=e7]:
    - rowheader "South" [ref=e8]
- button "Apply" [ref=e9]
- button "Apply" [ref=e10]
- button "Apply" [ref=e11]
- button "Apply" [ref=e12]
`);
const hidden = snapshot(`
- grid "Matrix" [ref=e101] [box=0,0,300,250]:
  - row [ref=e102] [box=0,0,300,50]:
    - columnheader "January" [ref=e103] [box=100,0,100,50]
    - columnheader "February" [ref=e104] [box=200,0,100,50]
  - row [ref=e105] [box=0,50,300,100]:
    - rowheader "North" [ref=e106] [box=0,50,100,100]
  - row [ref=e107] [box=0,150,300,100]:
    - rowheader "South" [ref=e108] [box=0,150,100,100]
- button "Apply" [ref=e21] [box=110,75,80,50]
- button "Apply" [ref=e22] [box=210,75,80,50]
- button "Apply" [ref=e23] [box=110,175,80,50]
- button "Apply" [ref=e24] [box=210,175,80,50]
`);
const requestArguments = Object.freeze({});
const request = Object.freeze({ name: 'browser_snapshot', arguments: requestArguments });
const calls = [];
const events = [];
const client = {
  async callTool(rawRequest, rawOptions) {
    calls.push([rawRequest, rawOptions]);
    return calls.length === 1 ? visible : hidden;
  },
  async listTools() { return { tools: [] }; },
};
const tools = harness.namespace.createAdaptivePlaywrightTools(client, {
  mode: 'auto',
  policySet: harness.namespace.createGridCoordinateReferencePolicy(),
  telemetry: { onEvent(event) { events.push(event); } },
});
const returned = await tools.callTool(request);
await tools.dispose();

if (returned === visible) throw new Error('Packed cross-realm request was not projected.');
if (calls.length !== 2) throw new Error(`Packed raw call count was ${calls.length}, expected 2.`);
if (calls[0][0] !== request) throw new Error('Packed visible request identity changed.');
if (
  calls[1][0]?.name !== 'browser_snapshot' ||
  calls[1][0]?.arguments?.boxes !== true ||
  Reflect.ownKeys(calls[1][0]?.arguments ?? {}).length !== 1
) throw new Error('Packed hidden request was not the exact boxes request.');
if (events.length !== 1) throw new Error(`Packed telemetry count was ${events.length}.`);
const event = events[0];
if (
  event?.schemaVersion !== 'adaptive-playwright-telemetry/1' ||
  event?.mode !== 'auto' ||
  event?.operation !== 'snapshot' ||
  event?.outcome !== 'projected' ||
  event?.hiddenCalls !== 1
) throw new Error(`Packed telemetry was invalid: ${JSON.stringify(event)}.`);

process.stdout.write(JSON.stringify({
  operation: event.operation,
  outcome: event.outcome,
  hiddenCalls: event.hiddenCalls,
  rawCallCount: calls.length,
  visibleRequestIdentity: calls[0][0] === request,
}));
