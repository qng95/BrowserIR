import type { Readable, Writable } from 'node:stream';

import {
  StdioServerTransport,
  serveStdio,
  type StdioServerHandle,
} from '@modelcontextprotocol/server/stdio';

import { createBrowserIrMcpServer } from './server.js';
import type { BrowserIrService } from './types.js';

export interface BrowserIrStdioOptions {
  service: BrowserIrService;
  enableUnsafeEvaluate?: boolean;
  input?: Readable;
  output?: Writable;
  onError?: (error: Error) => void;
}

export interface BrowserIrStdioHandle {
  /** Resolves only after the stdio connection and every owned browser are closed. */
  readonly closed: Promise<void>;
  /** Idempotently close the protocol connection and dispose the backing service. */
  close(): Promise<void>;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Serve one local MCP connection over stdio. The connection owns its service:
 * EOF, an explicit close, or a process-level shutdown must dispose all browser
 * sessions created through that service before shutdown completes.
 */
export function serveBrowserIrStdio(options: BrowserIrStdioOptions): BrowserIrStdioHandle {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const transport = new StdioServerTransport(input, output);
  let serverHandle: StdioServerHandle | undefined;
  let closePromise: Promise<void> | undefined;
  let disposePromise: Promise<void> | undefined;
  let resolveClosed: (() => void) | undefined;
  let rejectClosed: ((error: Error) => void) | undefined;
  let closedSettled = false;

  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });

  const settleClosed = (error?: Error): void => {
    if (closedSettled) return;
    closedSettled = true;
    input.off('end', onInputClosed);
    input.off('close', onInputClosed);
    if (error === undefined) resolveClosed?.();
    else rejectClosed?.(error);
  };

  const dispose = (): Promise<void> => {
    disposePromise ??= options.service.dispose?.() ?? Promise.resolve();
    return disposePromise;
  };

  const finishAfterServerClose = (): void => {
    void dispose().then(
      () => settleClosed(),
      (error: unknown) => settleClosed(asError(error)),
    );
  };

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      try {
        await serverHandle?.close();
      } finally {
        await dispose();
      }
    })().then(
      () => {
        settleClosed();
      },
      (error: unknown) => {
        const known = asError(error);
        settleClosed(known);
        throw known;
      },
    );
    return closePromise;
  };

  function onInputClosed(): void {
    void close().catch((error: unknown) => options.onError?.(asError(error)));
  }

  input.once('end', onInputClosed);
  input.once('close', onInputClosed);

  try {
    serverHandle = serveStdio(
      () => {
        const server = createBrowserIrMcpServer({
          service: options.service,
          enableUnsafeEvaluate: options.enableUnsafeEvaluate === true,
        });
        server.server.onclose = finishAfterServerClose;
        return server;
      },
      {
        legacy: 'reject',
        transport,
        ...(options.onError === undefined ? {} : { onerror: options.onError }),
      },
    );
  } catch (error) {
    const known = asError(error);
    void dispose().finally(() => settleClosed(known));
    throw known;
  }

  return { closed, close };
}
