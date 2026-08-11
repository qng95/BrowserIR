# `@browserir/playwright`

The maintained Playwright and Chromium driver for BrowserIR. It translates
browser state into normalized entities, relationships, capabilities, evidence,
and private action targets consumed by `@browserir/core`.

BrowserIR 0.1 is an unreleased alpha line. Public contracts may change between
0.1 releases.

## Install

```sh
pnpm add @browserir/core @browserir/playwright "playwright@1.62.0"
pnpm exec playwright install chromium
```

The package is ESM-only and requires Node.js 22.13 or newer.
Playwright is listed explicitly so its browser-installation CLI is available
under strict package-manager layouts such as pnpm's.

## Use

```ts
import { BrowserIRRuntime } from '@browserir/core';
import { createPlaywrightBrowserDriver } from '@browserir/playwright';

const runtime = new BrowserIRRuntime(createPlaywrightBrowserDriver());
```

The backend defaults to at most 32 tracked pages per session and 64 analyzed
documents per observation. Embedders can lower those bounds with
`maxPagesPerSession` and `maxFramesPerObservation`. Automatic downloads are
not accepted, and viewport/entity PNG captures are subject to the public core
pixel and byte limits.

Chromium is the only supported browser backend in BrowserIR 0.1.
