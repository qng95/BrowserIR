# `@browserir/playwright` — legacy full-graph driver

> **Status:** source-only legacy/experimental package. It backs the retained
> full-graph runtime and is not used by the current BrowserIR thin layer. For
> current integration, use
> [`browserir`](../playwright-mcp/README.md).

The retained Playwright and Chromium driver for the full-graph runtime. It translates
browser state into normalized entities, relationships, capabilities, evidence,
and private action targets consumed by `@browserir/core`.

This private package has not been published. Its contracts may change while the
legacy runtime remains in source.

## Planned package install

The following command applies only if publication of the full-graph packages
resumes; it does not work from the public registry today.

```sh
pnpm add @browserir/core @browserir/playwright "playwright@1.62.0"
pnpm exec playwright install chromium
```

The package is ESM-only and requires Node.js 22.13 or newer.
Playwright is listed explicitly so its browser-installation CLI is available
under strict package-manager layouts such as pnpm's.

## Legacy source use

```ts
import { BrowserIRRuntime } from '@browserir/core';
import { createPlaywrightBrowserDriver } from '@browserir/playwright';

const runtime = new BrowserIRRuntime(createPlaywrightBrowserDriver());
```

The backend defaults to at most 32 tracked pages per session and 64 analyzed
documents per observation. Embedders can lower those bounds with
`maxPagesPerSession` and `maxFramesPerObservation`. Automatic downloads are
not accepted, and viewport/entity PNG captures are subject to the legacy core
pixel and byte limits.

Chromium is the only backend implemented for this legacy 0.1 source line.
