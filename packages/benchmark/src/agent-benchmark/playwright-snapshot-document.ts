export const PLAYWRIGHT_INLINE_SNAPSHOT_DOCUMENT_VERSION =
  'playwright-inline-snapshot-document/1' as const;

const snapshotHeader = /^### Snapshot[ \t]*\r?\n/gmu;
const sectionHeader = /^### [^\r\n]+\r?(?:\n|$)/gmu;
const fileBackedSnapshot = /^(?:-\s+)?\[Snapshot\]\([^)]+\)$/u;
const boxToken = /^\s*\[box=-?\d+,-?\d+,\d+,\d+\]/u;
const refToken = /^\[ref=(?:f[1-9]\d*)?e[1-9]\d*\]/u;
const slashDelimitedRoleName =
  /^\s*-\s+[a-z][a-z0-9-]*\s+(\/.*\/)(?=\s+\[|:|\s*$)/iu;
const nativeRef = /^(?:f[1-9]\d*)?e[1-9]\d*$/u;

const normalized = (value: string): string =>
  value.normalize('NFKC').replace(/\s+/gu, ' ').trim();

const decodeName = (encoded: string | undefined): string | undefined => {
  if (encoded === undefined) return undefined;
  try {
    return JSON.parse(`"${encoded}"`) as string;
  } catch {
    throw new Error('Playwright snapshot contains an invalid quoted accessible name.');
  }
};

export interface PlaywrightSnapshotBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlaywrightSnapshotNode {
  index: number;
  parentIndex?: number | undefined;
  indent: number;
  role: string;
  name?: string | undefined;
  ref?: string | undefined;
  box?: PlaywrightSnapshotBox | undefined;
}

export interface PlaywrightInlineSnapshotDocument {
  schemaVersion: typeof PLAYWRIGHT_INLINE_SNAPSHOT_DOCUMENT_VERSION;
  sourceText: string;
  snapshotTree: string;
  snapshotContentStart: number;
  snapshotContentEnd: number;
  snapshotStyle: 'plain' | 'yaml-fence';
  pageUrl?: string | undefined;
}

const trimmedRange = (text: string): { start: number; end: number } => {
  const leading = /^\s*/u.exec(text)?.[0].length ?? 0;
  const trailing = /\s*$/u.exec(text)?.[0].length ?? 0;
  return { start: leading, end: text.length - trailing };
};

/**
 * Parse one exact inline full-page Playwright MCP Snapshot section. Results
 * with no snapshot or a file-backed/selective snapshot are intentionally not
 * eligible for adaptive rewriting and return undefined.
 */
export function parsePlaywrightInlineSnapshot(
  sourceText: string,
): PlaywrightInlineSnapshotDocument | undefined {
  snapshotHeader.lastIndex = 0;
  const matches = [...sourceText.matchAll(snapshotHeader)];
  snapshotHeader.lastIndex = 0;
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) {
    throw new Error('Playwright result contains more than one Snapshot section.');
  }
  const match = matches[0]!;
  const headerEnd = match.index! + match[0].length;
  sectionHeader.lastIndex = headerEnd;
  const nextHeader = sectionHeader.exec(sourceText);
  sectionHeader.lastIndex = 0;
  const sectionEnd = nextHeader?.index ?? sourceText.length;
  const rawSection = sourceText.slice(headerEnd, sectionEnd);
  const range = trimmedRange(rawSection);
  const trimmed = rawSection.slice(range.start, range.end);
  if (trimmed.length === 0 || fileBackedSnapshot.test(trimmed)) return undefined;

  let snapshotTree: string;
  let snapshotStyle: PlaywrightInlineSnapshotDocument['snapshotStyle'];
  const fenced = /^```ya?ml\r?\n([\s\S]*?)\r?\n```$/u.exec(trimmed);
  if (fenced !== null) {
    snapshotTree = `${fenced[1]!.trim()}\n`;
    snapshotStyle = 'yaml-fence';
  } else if (trimmed.startsWith('```')) {
    throw new Error('Playwright Snapshot section uses an unsupported fence.');
  } else {
    snapshotTree = `${trimmed.trim()}\n`;
    snapshotStyle = 'plain';
  }

  const pageUrls = [...sourceText.matchAll(/^- Page URL: ([^\r\n]+)$/gmu)];
  if (pageUrls.length > 1) {
    throw new Error('Playwright result contains more than one Page URL.');
  }
  return Object.freeze({
    schemaVersion: PLAYWRIGHT_INLINE_SNAPSHOT_DOCUMENT_VERSION,
    sourceText,
    snapshotTree,
    snapshotContentStart: headerEnd + range.start,
    snapshotContentEnd: headerEnd + range.end,
    snapshotStyle,
    ...(pageUrls[0]?.[1] === undefined ? {} : { pageUrl: pageUrls[0][1] }),
  });
}

const rewriteUnquotedTokens = (
  source: string,
  token: RegExp,
  replacement: string,
): string => source.split('\n').map((line) => {
  const slashNameMatch = slashDelimitedRoleName.exec(line);
  const slashName = slashNameMatch?.[1];
  const slashNameStart = slashName === undefined
    ? undefined
    : slashNameMatch![0].length - slashName.length;
  const slashNameEnd = slashNameStart === undefined
    ? undefined
    : slashNameStart + slashName!.length;
  let output = '';
  let quoted = false;
  let escaped = false;
  let metadataRegion = true;
  for (let index = 0; index < line.length;) {
    if (slashNameStart === index && slashNameEnd !== undefined) {
      output += line.slice(slashNameStart, slashNameEnd);
      index = slashNameEnd;
      continue;
    }
    const character = line[index]!;
    if (quoted) {
      output += character;
      index += 1;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      output += character;
      index += 1;
      continue;
    }
    if (character === ':') {
      metadataRegion = false;
      output += character;
      index += 1;
      continue;
    }
    const match = metadataRegion ? token.exec(line.slice(index)) : null;
    if (match !== null) {
      output += replacement;
      index += match[0].length;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}).join('\n');

export const stripPlaywrightSnapshotBoxes = (tree: string): string =>
  `${rewriteUnquotedTokens(tree, boxToken, '').trim()}\n`;

/**
 * A stateless semantic commitment for one immediate hidden recapture. It
 * deliberately ignores Playwright ref allocation and boxes, but preserves the
 * complete role/name/tree ordering. Identity-sensitive policies need a
 * stronger backend revision contract and cannot rely on this helper.
 */
export const playwrightSnapshotSemanticCommitment = (tree: string): string =>
  rewriteUnquotedTokens(
    stripPlaywrightSnapshotBoxes(tree),
    refToken,
    '[ref]',
  )
    .replace(/[ \t]+$/gmu, '')
    .replace(/\r\n?/gu, '\n');

export const samePlaywrightSnapshotState = (
  baseline: PlaywrightInlineSnapshotDocument,
  enriched: PlaywrightInlineSnapshotDocument,
): boolean =>
  baseline.pageUrl !== undefined &&
  baseline.pageUrl === enriched.pageUrl &&
  playwrightSnapshotSemanticCommitment(baseline.snapshotTree) ===
    playwrightSnapshotSemanticCommitment(enriched.snapshotTree);

export function renderPlaywrightSnapshotDocument(
  document: PlaywrightInlineSnapshotDocument,
  snapshotTree: string,
  sections: readonly Readonly<{ title: string; lines: readonly string[] }>[] = [],
): string {
  const tree = snapshotTree.trim();
  if (tree.length === 0) throw new Error('Adaptive snapshot rendering requires a non-empty tree.');
  for (const section of sections) {
    if (!/^[A-Za-z][A-Za-z0-9 -]{0,63}$/u.test(section.title) || section.lines.length === 0) {
      throw new Error('Adaptive snapshot rendering received an invalid bounded section.');
    }
    if (section.lines.some((line) => line.length === 0 || /[\r\n]/u.test(line))) {
      throw new Error('Adaptive snapshot section lines must be non-empty single lines.');
    }
  }
  const renderedTree = document.snapshotStyle === 'yaml-fence'
    ? `\`\`\`yaml\n${tree}\n\`\`\``
    : tree;
  const renderedSections = sections.map(({ title, lines }) =>
    `### ${title}\n${lines.join('\n')}`).join('\n\n');
  const replacement = renderedSections.length === 0
    ? renderedTree
    : `${renderedTree}\n\n${renderedSections}`;
  return `${document.sourceText.slice(0, document.snapshotContentStart)}${replacement}${document.sourceText.slice(document.snapshotContentEnd)}`;
}

export function parsePlaywrightSnapshotNodes(tree: string): readonly PlaywrightSnapshotNode[] {
  const nodes: PlaywrightSnapshotNode[] = [];
  const ancestors: Array<{ indent: number; index: number }> = [];
  for (const line of tree.replace(/\r\n?/gu, '\n').split('\n')) {
    const match = /^(\s*)-\s+([a-z][a-z0-9-]*)(?:\s+"((?:\\.|[^"\\])*)")?(.*)$/iu.exec(line);
    if (match === null) continue;
    const indent = match[1]!.replace(/\t/gu, '  ').length;
    while (ancestors.length > 0 && ancestors.at(-1)!.indent >= indent) ancestors.pop();
    const tail = match[4]!;
    const rawRef = /\[ref=([^\]]+)\]/u.exec(tail)?.[1];
    if (rawRef !== undefined && !nativeRef.test(rawRef)) {
      throw new Error('Playwright snapshot contains a malformed actionable ref.');
    }
    const boxMatch = /\[box=(-?\d+),(-?\d+),(\d+),(\d+)\]/u.exec(tail);
    const node: PlaywrightSnapshotNode = {
      index: nodes.length,
      ...(ancestors.at(-1) === undefined ? {} : { parentIndex: ancestors.at(-1)!.index }),
      indent,
      role: match[2]!.toLocaleLowerCase('en-US'),
      ...(match[3] === undefined ? {} : { name: normalized(decodeName(match[3])!) }),
      ...(rawRef === undefined ? {} : { ref: rawRef }),
      ...(boxMatch === null
        ? {}
        : {
            box: {
              x: Number(boxMatch[1]),
              y: Number(boxMatch[2]),
              width: Number(boxMatch[3]),
              height: Number(boxMatch[4]),
            },
          }),
    };
    nodes.push(node);
    ancestors.push({ indent, index: node.index });
  }
  return Object.freeze(nodes.map((node) => Object.freeze(node)));
}

export function isPlaywrightSnapshotDescendant(
  nodes: readonly PlaywrightSnapshotNode[],
  candidateIndex: number,
  ancestorIndex: number,
): boolean {
  let parent = nodes[candidateIndex]?.parentIndex;
  while (parent !== undefined) {
    if (parent === ancestorIndex) return true;
    parent = nodes[parent]?.parentIndex;
  }
  return false;
}
