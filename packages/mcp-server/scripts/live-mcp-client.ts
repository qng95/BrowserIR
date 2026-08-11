import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { BrowserIRRuntime } from '@browserir/core';
import { createPlaywrightBrowserDriver } from '@browserir/playwright';
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from '@modelcontextprotocol/client';

import {
  createBrowserIrMcpHandler,
  createBrowserIrRuntimeService,
} from '../src/index.js';

const targetUrl = process.argv[2];
if (!targetUrl) {
  throw new Error('Usage: vite-node scripts/live-mcp-client.ts <url>');
}

const runtime = new BrowserIRRuntime(
  createPlaywrightBrowserDriver({ headless: false }),
);
const service = createBrowserIrRuntimeService(runtime);
const handler = createBrowserIrMcpHandler({ service });
const transport = new StreamableHTTPClientTransport(
  new URL('http://browserir.local/mcp'),
  {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  },
);
const client = new Client(
  { name: 'browserir-live-client', version: '0.0.0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);

let browserId: string | undefined;
let imageNumber = 0;
const captureRoot = resolve(
  process.env['BROWSERIR_CAPTURE_DIR'] ??
    fileURLToPath(new URL('../../../output/playwright/browserir-live/', import.meta.url)),
);
const captureRunId = [
  new Date().toISOString().replace(/[:.]/g, '-'),
  String(process.pid),
  randomUUID().slice(0, 8),
].join('-');
const captureDirectory = resolve(captureRoot, captureRunId);

async function printResult(result: CallToolResult, label: string): Promise<void> {
  const text = result.content
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
  console.log('\n<<<BROWSERIR_RESULT>>>');
  console.log(
    JSON.stringify(
      {
        structuredContent: result.structuredContent,
        isError: result.isError === true,
      },
      null,
      2,
    ),
  );
  if (text) console.log(text);
  const images = result.content.filter(
    (item): item is { type: 'image'; data: string; mimeType: string } =>
      item.type === 'image',
  );
  if (images.length > 0) {
    await mkdir(captureDirectory, { recursive: true });
    for (const item of images) {
      const extension = item.mimeType === 'image/jpeg' ? 'jpg' : 'png';
      const safeLabel = label.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '');
      const path = resolve(
        captureDirectory,
        `${String(++imageNumber).padStart(3, '0')}-${safeLabel || 'capture'}.${extension}`,
      );
      await writeFile(path, Buffer.from(item.data, 'base64'), { flag: 'wx' });
      console.log(`BROWSERIR_IMAGE_PATH: ${path}`);
    }
  }
  console.log('<<<END_BROWSERIR_RESULT>>>\n');
}

async function close(): Promise<void> {
  if (browserId !== undefined) {
    await runtime.close({ browserId }).catch(() => {});
    browserId = undefined;
  }
  await client.close().catch(() => {});
  await handler.close().catch(() => {});
}

try {
  await client.connect(transport);
  const created = await client.callTool({
    name: 'browser_create',
    arguments: {
      viewport: {
        width: 1440,
        height: 900,
        device_scale_factor: 1,
      },
      color_scheme: 'light',
      reduced_motion: true,
    },
  });
  await printResult(created, 'browser-create');
  const createdData = created.structuredContent as {
    browser_id: string;
    page_id: string;
    revision: number;
  };
  browserId = createdData.browser_id;

  const navigated = await client.callTool({
    name: 'browser_navigate',
    arguments: {
      browser_id: createdData.browser_id,
      page_id: createdData.page_id,
      expected_revision: createdData.revision,
      url: targetUrl,
      max_tokens: 4_000,
    },
  });
  await printResult(navigated, 'browser-navigate');
  console.log(
    'BROWSERIR_READY: send one JSON line shaped as ' +
      '{"name":"browser_observe","arguments":{...}} or send "exit".',
  );

  const input = createInterface({
    input: process.stdin,
    terminal: false,
  });
  for await (const line of input) {
    const command = line.trim();
    if (!command) continue;
    if (command === 'exit') break;
    try {
      const request = JSON.parse(command) as {
        name: string;
        arguments?: Record<string, unknown>;
      };
      const result = await client.callTool({
        name: request.name,
        arguments: request.arguments ?? {},
      });
      await printResult(result, request.name);
    } catch (error) {
      console.error(
        `BROWSERIR_COMMAND_ERROR: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
} finally {
  await close();
}
