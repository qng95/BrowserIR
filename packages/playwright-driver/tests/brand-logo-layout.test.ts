import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, chromium } from 'playwright';

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const readBrandAsset = (name: string) =>
  readFileSync(`${workspaceRoot}assets/brand/${name}`, 'utf8');

const markSvg = readBrandAsset('browserir-mark.svg');
const logoBearingAssets = [
  ['browserir-mark.svg', markSvg],
  ['browserir-wordmark.svg', readBrandAsset('browserir-wordmark.svg')],
  ['browserir-wordmark-dark.svg', readBrandAsset('browserir-wordmark-dark.svg')],
  ['browserir-social-card.svg', readBrandAsset('browserir-social-card.svg')],
] as const;

type Rect = {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
};

const intersects = (left: Rect, right: Rect) =>
  left.left < right.right &&
  left.right > right.left &&
  left.top < right.bottom &&
  left.bottom > right.top;

async function renderSvg(browser: Browser, svg: string, width: number) {
  const page = await browser.newPage({ viewport: { width: width + 32, height: width + 32 } });
  await page.setContent(`<!doctype html><style>
    html, body { margin: 0; padding: 0; }
    svg { display: block; width: ${width}px; height: auto; }
  </style>${svg}`);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

describe('BrowserIR logo system', () => {
  let browser: Browser | undefined;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('keeps the canonical Compile Gate geometry identical in every logo-bearing asset', async () => {
    if (!browser) throw new Error('Chromium did not launch.');

    const signatures: Array<[string, string]> = [];
    for (const [name, svg] of logoBearingAssets) {
      const page = await renderSvg(browser, svg, 650);
      try {
        const signature = await page.evaluate(() => {
          const mark = document.querySelector('#browserir-mark');
          if (!(mark instanceof SVGGElement)) throw new Error('Missing #browserir-mark.');
          return [mark, ...Array.from(mark.querySelectorAll('*'))]
            .map((element) => {
              const attributes = Array.from(element.attributes)
                .map(({ name: attributeName, value }) => [attributeName, value] as const)
                .sort(([left], [right]) => left.localeCompare(right));
              return `${element.tagName}:${JSON.stringify(attributes)}`;
            })
            .join('|');
        });
        signatures.push([name, signature]);
      } finally {
        await page.close();
      }
    }

    const canonical = signatures[0]?.[1];
    expect(canonical).toBeDefined();
    for (const [name, signature] of signatures.slice(1)) {
      expect(signature, `${name} drifted from browserir-mark.svg`).toBe(canonical);
    }
  });

  it.each([160, 64, 32, 16])(
    'preserves the browser, source UI, compile gate, and structured IR at %ipx',
    async (width) => {
      if (!browser) throw new Error('Chromium did not launch.');
      const page = await renderSvg(browser, markSvg, width);
      try {
        const result = await page.evaluate(() => {
          const toRect = (selector: string): Rect => {
            const element = document.querySelector(selector);
            if (!(element instanceof SVGGraphicsElement)) {
              throw new Error(`Missing ${selector}.`);
            }
            const bounds = element.getBoundingClientRect();
            return {
              bottom: bounds.bottom,
              height: bounds.height,
              left: bounds.left,
              right: bounds.right,
              top: bounds.top,
              width: bounds.width,
            };
          };
          return {
            gate: toRect('#compile-gate'),
            ir: toRect('#structured-ir'),
            root: toRect('svg'),
            shell: toRect('#browser-shell'),
            source: toRect('#source-ui'),
          };
        });

        for (const [name, part] of Object.entries(result)) {
          expect(part.left, `${name} overflows left`).toBeGreaterThanOrEqual(result.root.left);
          expect(part.right, `${name} overflows right`).toBeLessThanOrEqual(result.root.right);
          expect(part.top, `${name} overflows top`).toBeGreaterThanOrEqual(result.root.top);
          expect(part.bottom, `${name} overflows bottom`).toBeLessThanOrEqual(
            result.root.bottom,
          );
        }
        for (const part of [result.source, result.gate, result.ir]) {
          expect(part.width).toBeGreaterThanOrEqual(2);
          expect(part.height).toBeGreaterThanOrEqual(4);
        }
        expect(intersects(result.source, result.gate)).toBe(false);
        expect(intersects(result.gate, result.ir)).toBe(false);
      } finally {
        await page.close();
      }
    },
  );

  it.each([
    ['browserir-wordmark.svg', 650],
    ['browserir-wordmark.svg', 325],
    ['browserir-wordmark-dark.svg', 650],
    ['browserir-wordmark-dark.svg', 325],
  ])('%s keeps the mark clear of its name and tagline at %ipx', async (name, width) => {
    if (!browser) throw new Error('Chromium did not launch.');
    const page = await renderSvg(browser, readBrandAsset(name), width);
    try {
      const layout = await page.evaluate(() => {
        const rect = (selector: string): Rect => {
          const element = document.querySelector(selector);
          if (!(element instanceof SVGGraphicsElement)) throw new Error(`Missing ${selector}.`);
          const bounds = element.getBoundingClientRect();
          return {
            bottom: bounds.bottom,
            height: bounds.height,
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
            width: bounds.width,
          };
        };
        return {
          mark: rect('#browserir-mark'),
          name: rect('#wordmark-name'),
          tagline: rect('#wordmark-tagline'),
        };
      });
      expect(intersects(layout.mark, layout.name)).toBe(false);
      expect(intersects(layout.name, layout.tagline)).toBe(false);
    } finally {
      await page.close();
    }
  });

  it.each([1280, 640])(
    'keeps the social-card mark separate from the BrowserIR name at %ipx',
    async (width) => {
      if (!browser) throw new Error('Chromium did not launch.');
      const page = await renderSvg(
        browser,
        readBrandAsset('browserir-social-card.svg'),
        width,
      );
      try {
        const collision = await page.evaluate(() => {
          const mark = document.querySelector('#browserir-mark');
          const name = document.querySelector('#social-wordmark');
          if (!(mark instanceof SVGGraphicsElement) || !(name instanceof SVGGraphicsElement)) {
            throw new Error('Social-card logo elements are missing.');
          }
          const left = mark.getBoundingClientRect();
          const right = name.getBoundingClientRect();
          return (
            left.left < right.right &&
            left.right > right.left &&
            left.top < right.bottom &&
            left.bottom > right.top
          );
        });
        expect(collision).toBe(false);
      } finally {
        await page.close();
      }
    },
  );
});
