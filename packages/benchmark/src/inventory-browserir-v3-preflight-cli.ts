import { runInventoryBrowserIrV3LivePreflight } from
  './agent-benchmark/inventory-browserir-v3-live-preflight.js';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--headed')) {
  throw new Error('Usage: inventory-browserir-v3-preflight-cli [--headed]');
}

const result = await runInventoryBrowserIrV3LivePreflight({
  headless: !args.includes('--headed'),
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
