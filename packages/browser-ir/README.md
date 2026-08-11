# `@browserir/core`

Browser-independent BrowserIR types, reconciliation, revision safety, deltas,
action verification, and compact model-facing view compilation.

BrowserIR 0.1 is an unreleased alpha line. Public contracts may change between
0.1 releases.

## Install

```sh
pnpm add @browserir/core
```

The package is ESM-only and requires Node.js 22.13 or newer.

## Use

```ts
import { BrowserIRRuntime, compileView } from '@browserir/core';
```

`BrowserIRRuntime` accepts a browser-driver implementation. Use
`@browserir/playwright` for the maintained Chromium backend.
