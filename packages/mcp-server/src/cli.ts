#!/usr/bin/env node

import { BrowserIRRuntime } from '@browserir/core';
import { createPlaywrightBrowserDriver } from '@browserir/playwright';

import {
  parseBrowserIrCliOptions,
  renderBrowserIrCliHelp,
} from './cli-options.js';
import { createBrowserIrRuntimeService } from './runtime-service.js';
import { serveBrowserIrStdio } from './stdio.js';
import { BROWSERIR_VERSION } from './version.js';

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

async function main(): Promise<void> {
  const options = parseBrowserIrCliOptions(process.argv.slice(2));
  if (options.command === 'help') {
    process.stdout.write(renderBrowserIrCliHelp());
    return;
  }
  if (options.command === 'version') {
    process.stdout.write(`${BROWSERIR_VERSION}\n`);
    return;
  }

  const runtime = new BrowserIRRuntime(
    createPlaywrightBrowserDriver({ headless: options.headless }),
  );
  const service = createBrowserIrRuntimeService(runtime, {
    ...(options.enableUnsafeEvaluate
      ? {
          unsafeEvaluate: {
            audit: (record: unknown) => {
              process.stderr.write(
                `${JSON.stringify({ event: 'browserir_unsafe_evaluate', record })}\n`,
              );
            },
          },
        }
      : {}),
  });
  const handle = serveBrowserIrStdio({
    service,
    enableUnsafeEvaluate: options.enableUnsafeEvaluate,
    onError: (error) => {
      process.stderr.write(`BrowserIR MCP transport error: ${error.message}\n`);
    },
  });

  const shutdownForSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    void handle.close().catch((error: unknown) => {
      process.stderr.write(`BrowserIR MCP shutdown error: ${errorMessage(error)}\n`);
      process.exitCode = 1;
    });
  };
  const onSigint = (): void => shutdownForSignal('SIGINT');
  const onSigterm = (): void => shutdownForSignal('SIGTERM');
  const onFatal = (error: unknown): void => {
    process.stderr.write(`BrowserIR MCP fatal error: ${errorMessage(error)}\n`);
    process.exitCode = 1;
    void handle.close().catch(() => {});
  };

  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  process.once('uncaughtException', onFatal);
  process.once('unhandledRejection', onFatal);

  try {
    await handle.closed;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    process.off('uncaughtException', onFatal);
    process.off('unhandledRejection', onFatal);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`BrowserIR MCP failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
