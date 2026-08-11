import type {
  Browser,
  BrowserContext,
  CDPSession,
  LaunchOptions,
  Page,
} from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import { PlaywrightBrowserDriver } from '../src/index.js';

class InjectedBrowserDriver extends PlaywrightBrowserDriver {
  readonly launches: LaunchOptions[] = [];

  constructor(private readonly browsers: Browser[]) {
    super();
  }

  protected override async launchBrowser(
    options: LaunchOptions,
  ): Promise<Browser> {
    this.launches.push(options);
    const browser = this.browsers.shift();
    if (browser === undefined) throw new Error('No injected browser remains.');
    return browser;
  }
}

const browserDouble = (input: {
  newContext: (...arguments_: unknown[]) => Promise<BrowserContext>;
  close?: () => Promise<void>;
}) => {
  const newContext = vi.fn(input.newContext);
  const close = vi.fn(input.close ?? (async () => {}));
  return {
    browser: { newContext, close } as unknown as Browser,
    newContext,
    close,
  };
};

const contextDouble = (input: {
  addInitScript?: (...arguments_: unknown[]) => Promise<void>;
  newPage: () => Promise<Page>;
  close?: () => Promise<void>;
}) => {
  const addInitScript = vi.fn(input.addInitScript ?? (async () => {}));
  const newPage = vi.fn(input.newPage);
  const close = vi.fn(input.close ?? (async () => {}));
  const context = {
    on: vi.fn(),
    addInitScript,
    newPage,
    close,
  } as unknown as BrowserContext;
  return { context, addInitScript, newPage, close };
};

const pageDouble = (registrationError?: Error, closeError?: Error) => {
  const close = vi.fn(async () => {
    if (closeError !== undefined) throw closeError;
  });
  const page = {
    on: vi.fn((event: string) => {
      if (event === 'request' && registrationError !== undefined) {
        throw registrationError;
      }
      return page;
    }),
    once: vi.fn(() => page),
    close,
  } as unknown as Page;
  return { page, close };
};

describe('PlaywrightBrowserDriver partial initialization cleanup', () => {
  it('rejects an oversized physical-pixel profile before launching Chromium', async () => {
    const driver = new InjectedBrowserDriver([]);

    await expect(
      driver.createSession({
        viewport: { width: 3840, height: 2160 },
        deviceScaleFactor: 3,
      }),
    ).rejects.toThrow(/physical-pixel capture limit/);
    expect(driver.launches).toHaveLength(0);
  });

  it('closes a launched browser when profile/context creation fails and preserves that error', async () => {
    const contextError = new Error('context profile setup failed');
    const cleanupError = new Error('browser cleanup failed');
    const double = browserDouble({
      newContext: async () => {
        throw contextError;
      },
      close: async () => {
        throw cleanupError;
      },
    });
    const driver = new InjectedBrowserDriver([double.browser]);

    await expect(
      driver.createSession({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 2,
        colorScheme: 'dark',
        reducedMotion: 'no-preference',
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin',
      }),
    ).rejects.toBe(contextError);

    expect(double.newContext).toHaveBeenCalledWith({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2,
      acceptDownloads: false,
      colorScheme: 'dark',
      reducedMotion: 'no-preference',
      serviceWorkers: 'allow',
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
    });
    expect(double.close).toHaveBeenCalledTimes(1);
  });

  it('closes context and browser once when init-script installation fails, even if context cleanup fails', async () => {
    const initError = new Error('init script failed');
    const contextCleanupError = new Error('context cleanup failed');
    const context = contextDouble({
      addInitScript: async () => {
        throw initError;
      },
      newPage: async () => {
        throw new Error('newPage must not run');
      },
      close: async () => {
        throw contextCleanupError;
      },
    });
    const browser = browserDouble({
      newContext: async () => context.context,
    });

    await expect(
      new InjectedBrowserDriver([browser.browser]).createSession(),
    ).rejects.toBe(initError);

    expect(context.addInitScript).toHaveBeenCalledTimes(1);
    expect(context.newPage).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('closes context and browser once when initial page creation fails', async () => {
    const pageError = new Error('initial page failed');
    const context = contextDouble({
      newPage: async () => {
        throw pageError;
      },
    });
    const browser = browserDouble({
      newContext: async () => context.context,
    });

    await expect(
      new InjectedBrowserDriver([browser.browser]).createSession(),
    ).rejects.toBe(pageError);

    expect(context.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('closes an already-created page, context, and browser once when page registration fails', async () => {
    const registrationError = new Error('initial page registration failed');
    const page = pageDouble(
      registrationError,
      new Error('initial page cleanup failed'),
    );
    const context = contextDouble({ newPage: async () => page.page });
    const browser = browserDouble({
      newContext: async () => context.context,
    });

    await expect(
      new InjectedBrowserDriver([browser.browser]).createSession(),
    ).rejects.toBe(registrationError);

    expect(page.close).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('does not retain failed initialization state and permits a clean retry', async () => {
    const firstError = new Error('first context failed');
    const failedBrowser = browserDouble({
      newContext: async () => {
        throw firstError;
      },
    });
    const page = pageDouble();
    const healthyContext = contextDouble({ newPage: async () => page.page });
    const healthyBrowser = browserDouble({
      newContext: async () => healthyContext.context,
    });
    const driver = new InjectedBrowserDriver([
      failedBrowser.browser,
      healthyBrowser.browser,
    ]);

    await expect(driver.createSession()).rejects.toBe(firstError);
    const session = await driver.createSession();

    expect(session.initialPageId).toBe('page_1');
    expect(driver.launches).toHaveLength(2);
    expect(driver.launches).toEqual([
      {
        handleSIGHUP: false,
        handleSIGINT: false,
        handleSIGTERM: false,
        headless: true,
      },
      {
        handleSIGHUP: false,
        handleSIGINT: false,
        handleSIGTERM: false,
        headless: true,
      },
    ]);
    expect(failedBrowser.close).toHaveBeenCalledTimes(1);
    await session.close();
    await session.close();
    expect(healthyContext.close).toHaveBeenCalledTimes(1);
    expect(healthyBrowser.close).toHaveBeenCalledTimes(1);
  });

  it('attempts every full-session cleanup and reports all failures without claiming closure', async () => {
    const contextError = new Error('context close failed');
    const browserError = new Error('browser close failed');
    const page = pageDouble();
    const context = contextDouble({
      newPage: async () => page.page,
      close: async () => {
        throw contextError;
      },
    });
    const browser = browserDouble({
      newContext: async () => context.context,
      close: async () => {
        throw browserError;
      },
    });
    const session = await new InjectedBrowserDriver([
      browser.browser,
    ]).createSession();

    const failure = await session.close().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      contextError,
      browserError,
    ]);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);

    await expect(session.close()).rejects.toBeInstanceOf(AggregateError);
    expect(context.close).toHaveBeenCalledTimes(2);
    expect(browser.close).toHaveBeenCalledTimes(2);
  });

  it('irreversibly invalidates the owned session when unsafe page containment fails', async () => {
    const stalled = new Promise<never>(() => {});
    const client = {
      async send(method: string): Promise<unknown> {
        if (method === 'Runtime.evaluate') {
          throw new Error('unexpected CDP transport failure');
        }
        if (method === 'Runtime.terminateExecution') {
          return stalled;
        }
        if (method === 'Runtime.releaseObjectGroup') return {};
        throw new Error(`Unexpected fake CDP method ${method}.`);
      },
      async detach(): Promise<void> {},
    } as unknown as CDPSession;
    let context: BrowserContext;
    const pageClose = vi.fn(async () => {
      throw new Error('target close failed');
    });
    const page = {
      on: vi.fn(function (this: Page) {
        return this;
      }),
      once: vi.fn(function (this: Page) {
        return this;
      }),
      context: () => context,
      isClosed: () => false,
      close: pageClose,
    } as unknown as Page;
    const contextClose = vi.fn(async () => {
      throw new Error('context close failed');
    });
    context = {
      on: vi.fn(),
      addInitScript: vi.fn(async () => {}),
      newPage: vi.fn(async () => page),
      newCDPSession: vi.fn(async () => client),
      close: contextClose,
    } as unknown as BrowserContext;
    const browserClose = vi.fn(async () => {
      throw new Error('browser close failed');
    });
    const browser = {
      newContext: vi.fn(async () => context),
      close: browserClose,
    } as unknown as Browser;
    const session = await new InjectedBrowserDriver([browser]).createSession();

    const result = await session.evaluateUnsafe!({
      pageId: session.initialPageId,
      expression: '({ answer: 42 })',
      timeoutMs: 25,
      maxOutputBytes: 4_096,
    });

    expect(result).toMatchObject({
      dispatched: true,
      outcome: 'serialization_failed',
      terminationAttempted: true,
      terminationConfirmed: false,
      browserInvalidated: true,
    });
    expect(pageClose).toHaveBeenCalledTimes(1);
    expect(contextClose).toHaveBeenCalledTimes(1);
    expect(browserClose).toHaveBeenCalledTimes(1);
    await expect(session.pages()).rejects.toThrow(/closed/i);
    await expect(
      session.observe({ pageId: session.initialPageId }),
    ).rejects.toThrow(/closed/i);
    await session.close();
    expect(contextClose).toHaveBeenCalledTimes(1);
    expect(browserClose).toHaveBeenCalledTimes(1);
  });
});
