import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, chromium } from 'playwright';

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const architectureSvg = readFileSync(
  `${workspaceRoot}assets/brand/browserir-architecture.svg`,
  'utf8',
);

type LayoutIssue = {
  kind: 'collision' | 'missing' | 'overflow' | 'structure';
  message: string;
};

async function inspectArchitecture(browser: Browser, width: number): Promise<LayoutIssue[]> {
  const page = await browser.newPage({
    viewport: { width: width + 32, height: Math.ceil((width * 760) / 1400) + 32 },
  });

  try {
    await page.setContent(`<!doctype html><style>
      html, body { margin: 0; padding: 0; }
      svg { display: block; width: ${width}px; height: auto; }
    </style>${architectureSvg}`);
    await page.evaluate(() => document.fonts.ready);

    return await page.evaluate((renderWidth) => {
      type Rect = {
        bottom: number;
        height: number;
        left: number;
        right: number;
        top: number;
        width: number;
      };

      const issues: LayoutIssue[] = [];
      const svg = document.querySelector('svg');
      if (!(svg instanceof SVGSVGElement)) {
        return [{ kind: 'missing', message: 'root SVG element is missing' }];
      }

      const scale = renderWidth / svg.viewBox.baseVal.width;
      const root = svg.getBoundingClientRect();
      const rect = (selector: string): Rect | undefined => {
        const element = document.querySelector(selector);
        if (!(element instanceof SVGGraphicsElement)) {
          issues.push({ kind: 'missing', message: `${selector} is missing` });
          return undefined;
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
      const intersects = (left: Rect, right: Rect, clearance = 0) =>
        left.left < right.right + clearance &&
        left.right > right.left - clearance &&
        left.top < right.bottom + clearance &&
        left.bottom > right.top - clearance;
      const separation = (left: Rect, right: Rect) => {
        const horizontal = Math.max(left.left - right.right, right.left - left.right, 0);
        const vertical = Math.max(left.top - right.bottom, right.top - left.bottom, 0);
        return Math.hypot(horizontal, vertical);
      };
      const inside = (inner: Rect, outer: Rect, padding = 0) =>
        inner.left >= outer.left + padding &&
        inner.right <= outer.right - padding &&
        inner.top >= outer.top + padding &&
        inner.bottom <= outer.bottom - padding;

      for (const text of Array.from(document.querySelectorAll('text'))) {
        const bounds = text.getBoundingClientRect();
        if (
          bounds.left < root.left - 0.5 ||
          bounds.top < root.top - 0.5 ||
          bounds.right > root.right + 0.5 ||
          bounds.bottom > root.bottom + 0.5
        ) {
          issues.push({
            kind: 'overflow',
            message: `text overflows canvas: ${text.textContent?.trim() ?? '<empty>'}`,
          });
        }
      }

      const fitChecks: Array<[string, string, number]> = [
        ['#alpha-badge-copy', '#alpha-badge-bg', 8],
        ['#observation-flow-copy', '#observation-flow-band', 8],
        ['#chromium-target-copy', '#chromium-target-pill', 10],
        ['#receipt-summary', '#receipt-panel', 12],
        ['#receipt-footnote', '#receipt-panel', 12],
      ];
      for (const [innerSelector, outerSelector, padding] of fitChecks) {
        const inner = rect(innerSelector);
        const outer = rect(outerSelector);
        if (inner && outer && !inside(inner, outer, padding * scale)) {
          issues.push({
            kind: 'overflow',
            message: `${innerSelector} does not fit inside ${outerSelector}: inner=${JSON.stringify(inner)} outer=${JSON.stringify(outer)} padding=${padding * scale}`,
          });
        }
      }

      const connectorNames = ['result', 'request', 'view', 'call', 'observation', 'action'];
      const cards = ['#agent-card', '#mcp-card', '#core-card', '#backend-card'];
      const labelToCardClearance = 8;
      const labelToVisibleArrowClearance = 8;
      const arrowToCardClearance = 6;
      const arrowheadHalfHeight = 5 * scale;

      for (const markerId of ['arrow-right', 'arrow-left']) {
        const marker = document.querySelector(`#${markerId}`);
        if (!(marker instanceof SVGMarkerElement)) {
          issues.push({ kind: 'missing', message: `${markerId} marker is missing` });
        } else if (marker.getAttribute('markerUnits') !== 'userSpaceOnUse') {
          issues.push({
            kind: 'structure',
            message: `${markerId} must use predictable user-space dimensions`,
          });
        }
      }

      for (const name of connectorNames) {
        const connector = document.querySelector(`[data-connector="${name}"]`);
        if (!(connector instanceof SVGPathElement)) {
          issues.push({ kind: 'missing', message: `${name} connector is missing` });
          continue;
        }
        const commands = connector.getAttribute('d')?.match(/[a-z]/gi) ?? [];
        const marker = connector.getAttribute('marker-end');
        if (
          commands.filter((command) => command.toLowerCase() === 'm').length !== 1 ||
          (marker !== 'url(#arrow-right)' && marker !== 'url(#arrow-left)')
        ) {
          issues.push({
            kind: 'structure',
            message: `${name} must be one directed path with one marker-end`,
          });
        }

        const label = rect(`#${name}-connector-label`);
        const line = rect(`[data-connector="${name}"]`);
        if (
          label &&
          line &&
          separation(label, line) - arrowheadHalfHeight < labelToVisibleArrowClearance
        ) {
          issues.push({
            kind: 'collision',
            message: `${name} label has less than ${labelToVisibleArrowClearance}px clearance from its visible arrow`,
          });
        }
        for (const cardSelector of cards) {
          const card = rect(cardSelector);
          if (label && card && separation(label, card) < labelToCardClearance) {
            issues.push({
              kind: 'collision',
              message: `${name} label has less than ${labelToCardClearance}px clearance from ${cardSelector}`,
            });
          }
          if (line && card && separation(line, card) < arrowToCardClearance) {
            issues.push({
              kind: 'collision',
              message: `${name} arrow has less than ${arrowToCardClearance}px clearance from ${cardSelector}`,
            });
          }
        }
      }

      const separationChecks: Array<[string, string, number]> = [
        ['#diagram-title', '#alpha-badge', 12],
        ['#driver-port-badge', '#core-title', 8],
        ['#driver-port-badge', '#backend-title', 8],
        ['#observation-connector-label', '#action-connector-label', 8],
        ['#receipt-pills', '#receipt-summary', 12],
        ['#receipt-summary', '#receipt-footnote', 8],
        ['#footer-model', '#footer-private', 12],
      ];
      for (const [leftSelector, rightSelector, clearance] of separationChecks) {
        const left = rect(leftSelector);
        const right = rect(rightSelector);
        if (left && right && intersects(left, right, clearance * scale)) {
          issues.push({
            kind: 'collision',
            message: `${leftSelector} collides with ${rightSelector}`,
          });
        }
      }

      return issues;
    }, width);
  } finally {
    await page.close();
  }
}

describe('README architecture diagram layout', () => {
  let browser: Browser | undefined;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it.each([1400, 700])(
    'has no text overflow or connector-label collisions at %ipx',
    async (width) => {
      if (!browser) throw new Error('Chromium did not launch.');
      expect(await inspectArchitecture(browser, width)).toEqual([]);
    },
  );
});
