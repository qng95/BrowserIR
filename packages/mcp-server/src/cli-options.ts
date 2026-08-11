export type BrowserIrCliCommand = 'serve' | 'help' | 'version';

export interface BrowserIrCliOptions {
  command: BrowserIrCliCommand;
  headless: boolean;
  enableUnsafeEvaluate: boolean;
}

export function parseBrowserIrCliOptions(args: readonly string[]): BrowserIrCliOptions {
  let command: BrowserIrCliCommand = 'serve';
  let displayMode: 'headless' | 'headful' | undefined;
  let enableUnsafeEvaluate = false;

  for (const argument of args) {
    if (argument === '--help' || argument === '-h') {
      if (command !== 'serve') throw new Error('Conflicting CLI commands.');
      command = 'help';
      continue;
    }
    if (argument === '--version' || argument === '-v') {
      if (command !== 'serve') throw new Error('Conflicting CLI commands.');
      command = 'version';
      continue;
    }
    if (argument === '--headless' || argument === '--headful') {
      const requested = argument === '--headless' ? 'headless' : 'headful';
      if (displayMode === requested) throw new Error(`Duplicate ${argument} option.`);
      if (displayMode !== undefined) throw new Error('Conflicting browser display options.');
      displayMode = requested;
      continue;
    }
    if (argument === '--enable-unsafe-evaluate') {
      if (enableUnsafeEvaluate) {
        throw new Error('Duplicate --enable-unsafe-evaluate option.');
      }
      enableUnsafeEvaluate = true;
      continue;
    }
    throw new Error(`Unknown option: ${argument}.`);
  }

  return {
    command,
    headless: displayMode !== 'headful',
    enableUnsafeEvaluate,
  };
}

export function renderBrowserIrCliHelp(): string {
  return [
    'Usage: browserir-mcp [--headless | --headful] [--enable-unsafe-evaluate]',
    '',
    'Serve one local BrowserIR MCP connection over stdio.',
    '',
    'Options:',
    '  --headless       Run Chromium without a visible window (default).',
    '  --headful        Show the Chromium window for observation and debugging.',
    '  --enable-unsafe-evaluate',
    '                   DANGEROUS: allow bounded page code execution. Disabled by default.',
    '  -h, --help       Show this help and exit.',
    '  -v, --version    Show the BrowserIR version and exit.',
    '',
  ].join('\n');
}
