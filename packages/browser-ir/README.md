# `@browserir/core` — legacy full-graph core

> **Status:** source-only legacy/experimental package. It remains for the
> retained full-graph runtime and is not the current BrowserIR thin-layer
> product. For current integration, use
> [`@browserir/playwright-mcp`](../playwright-mcp/README.md).

Browser-independent BrowserIR types, reconciliation, revision safety, deltas,
action verification, and compact model-facing view compilation.

This private package has not been published. Its contracts may change while the
legacy runtime remains in source.

## Planned package install

The following command applies only if publication of the full-graph packages
resumes; it does not work from the public registry today.

```sh
pnpm add @browserir/core
```

The package is ESM-only and requires Node.js 22.13 or newer.

## Legacy source use

```ts
import { BrowserIRRuntime, compileView } from '@browserir/core';
```

`BrowserIRRuntime` accepts a browser-driver implementation. The retained
`@browserir/playwright` package supplies the Chromium backend.
