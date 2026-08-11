import { describe, expect, it } from 'vitest';

import {
  parseBrowserIrCliOptions,
  renderBrowserIrCliHelp,
} from '../src/cli-options.js';

describe('browserir-mcp CLI options', () => {
  it('serves headless by default and supports an explicit visible browser', () => {
    expect(parseBrowserIrCliOptions([])).toEqual({
      command: 'serve',
      headless: true,
      enableUnsafeEvaluate: false,
    });
    expect(parseBrowserIrCliOptions(['--headful'])).toEqual({
      command: 'serve',
      headless: false,
      enableUnsafeEvaluate: false,
    });
    expect(parseBrowserIrCliOptions(['--headless'])).toEqual({
      command: 'serve',
      headless: true,
      enableUnsafeEvaluate: false,
    });
  });

  it('requires an explicit startup flag for unsafe page evaluation', () => {
    expect(parseBrowserIrCliOptions(['--enable-unsafe-evaluate'])).toEqual({
      command: 'serve',
      headless: true,
      enableUnsafeEvaluate: true,
    });
    expect(renderBrowserIrCliHelp()).toContain('--enable-unsafe-evaluate');
    expect(renderBrowserIrCliHelp()).toMatch(/dangerous/i);
    expect(renderBrowserIrCliHelp()).toMatch(/disabled by default/i);
    expect(() =>
      parseBrowserIrCliOptions([
        '--enable-unsafe-evaluate',
        '--enable-unsafe-evaluate',
      ]),
    ).toThrow(/duplicate/i);
  });

  it('recognizes help and version without starting an MCP transport', () => {
    expect(parseBrowserIrCliOptions(['--help']).command).toBe('help');
    expect(parseBrowserIrCliOptions(['-h']).command).toBe('help');
    expect(parseBrowserIrCliOptions(['--version']).command).toBe('version');
    expect(parseBrowserIrCliOptions(['-v']).command).toBe('version');
    expect(renderBrowserIrCliHelp()).toContain('browserir-mcp [--headless | --headful]');
  });

  it('rejects unknown, duplicate, and conflicting options', () => {
    expect(() => parseBrowserIrCliOptions(['--wat'])).toThrow(/unknown option/i);
    expect(() => parseBrowserIrCliOptions(['--headful', '--headful'])).toThrow(/duplicate/i);
    expect(() => parseBrowserIrCliOptions(['--headful', '--headless'])).toThrow(/conflicting/i);
    expect(() => parseBrowserIrCliOptions(['--help', '--version'])).toThrow(/conflicting/i);
  });
});
