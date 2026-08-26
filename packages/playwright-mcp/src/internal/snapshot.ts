export const SNAPSHOT_DOCUMENT_VERSION = 'playwright-inline-snapshot/1' as const;

const MAX_SOURCE_UTF16_UNITS = 1_000_000;
const MAX_SOURCE_UTF8_BYTES = 1_000_000;
const MAX_SNAPSHOT_LINES = 20_000;
const MAX_LINE_UTF16_UNITS = 16_384;
const MAX_NODES = 10_000;

const nativeRef = /^(?:f[1-9]\d*)?e[1-9]\d*$/u;
const boundedCode = /^[a-z][a-z0-9-]{0,63}$/u;
const boundedVersion = /^[a-z][a-z0-9-]{0,47}\/[1-9]\d{0,5}$/u;
const attributeKey = /^[a-z][a-z0-9-]{0,31}$/u;
const unsafeGeneratedCodePoint = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const bidiControl = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const forbiddenSemanticAttribute = new Set([
  'answer', 'correct', 'expected', 'oracle', 'query', 'reason', 'route',
  'selected', 'target', 'world',
]);
const geometryAttributeAliases = new Set([
  'x', 'y', 'w', 'h', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy',
  'left', 'right', 'top', 'bottom', 'width', 'height',
  'box', 'bbox', 'bounds', 'boundingbox', 'rect', 'rectangle',
  'geometry', 'position', 'size', 'offset', 'origin', 'center',
  'centerx', 'centery', 'coord', 'coords', 'coordinate', 'coordinates',
  'dimension', 'dimensions', 'location', 'point', 'points', 'xy', 'xywh',
]);

const textEncoder = new TextEncoder();

export interface SnapshotScanCounter {
  operations: number;
}

interface LineView {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly nextStart: number;
  readonly hasLineBreak: boolean;
}

const addOperations = (
  counter: SnapshotScanCounter | undefined,
  amount: number,
): void => {
  if (counter !== undefined) counter.operations += amount;
};

const forEachLine = (
  source: string,
  visitor: (line: LineView) => void,
  counter?: SnapshotScanCounter | undefined,
): void => {
  let start = 0;
  while (start <= source.length) {
    const lineBreak = source.indexOf('\n', start);
    const hasLineBreak = lineBreak !== -1;
    const rawEnd = hasLineBreak ? lineBreak : source.length;
    const end = rawEnd > start && source.charCodeAt(rawEnd - 1) === 13
      ? rawEnd - 1
      : rawEnd;
    addOperations(counter, rawEnd - start + (hasLineBreak ? 1 : 0));
    visitor({
      text: source.slice(start, end),
      start,
      end,
      nextStart: hasLineBreak ? rawEnd + 1 : source.length,
      hasLineBreak,
    });
    if (!hasLineBreak) break;
    start = rawEnd + 1;
  }
};

const byteLength = (value: string): number => textEncoder.encode(value).byteLength;

const assertBoundedText = (source: string): void => {
  if (
    source.length > MAX_SOURCE_UTF16_UNITS ||
    byteLength(source) > MAX_SOURCE_UTF8_BYTES
  ) throw new Error('Snapshot text exceeds the parser bound.');
};

const assertBoundedTree = (
  tree: string,
  counter?: SnapshotScanCounter | undefined,
): void => {
  let lines = 0;
  forEachLine(tree, ({ text }) => {
    lines += 1;
    if (lines > MAX_SNAPSHOT_LINES) throw new Error('Snapshot tree exceeds the line bound.');
    if (text.length > MAX_LINE_UTF16_UNITS) {
      throw new Error('Snapshot tree contains an oversized line.');
    }
  }, counter);
};

export interface InlineSnapshotDocument {
  readonly schemaVersion: typeof SNAPSHOT_DOCUMENT_VERSION;
  readonly sourceText: string;
  readonly snapshotTree: string;
  readonly snapshotContentStart: number;
  readonly snapshotContentEnd: number;
  readonly snapshotStyle: 'plain' | 'yaml-fence';
  readonly pageUrl?: string | undefined;
}

export interface SnapshotBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SnapshotNode {
  readonly index: number;
  readonly parentIndex?: number | undefined;
  readonly indent: number;
  readonly role: string;
  readonly name?: string | undefined;
  readonly ref?: string | undefined;
  readonly box?: SnapshotBox | undefined;
}

export interface SupplementProvenance {
  readonly policyId: string;
  readonly policyVersion: string;
}

export interface StructuralFact {
  readonly kind: string;
  readonly ref: string;
  readonly attributes: Readonly<Record<string, string>>;
}

export interface StructuralSupplement {
  readonly schema: string;
  readonly provenance: SupplementProvenance;
  readonly facts: readonly StructuralFact[];
}

export interface SupplementFactContract {
  readonly kind: string;
  readonly attributes: readonly string[];
}

export interface SupplementContract {
  readonly schema: string;
  readonly facts: readonly SupplementFactContract[];
}

export interface SupplementAuthority {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly supplementContracts: readonly SupplementContract[];
}

const exactSnapshotHeader = (line: string): boolean => {
  const prefix = '### Snapshot';
  if (!line.startsWith(prefix)) return false;
  for (let index = prefix.length; index < line.length; index += 1) {
    const code = line.charCodeAt(index);
    if (code !== 32 && code !== 9) return false;
  }
  return true;
};

const isSectionHeader = (line: string): boolean =>
  line.length > 4 && line.startsWith('### ');

const whitespace = /\s/u;

const trimmedRange = (
  source: string,
  counter?: SnapshotScanCounter | undefined,
): { start: number; end: number } => {
  let start = 0;
  let end = source.length;
  while (start < end && whitespace.test(source[start]!)) {
    start += 1;
    addOperations(counter, 1);
  }
  while (end > start && whitespace.test(source[end - 1]!)) {
    end -= 1;
    addOperations(counter, 1);
  }
  return { start, end };
};

const inlineSnapshotTree = (
  trimmed: string,
): { style: InlineSnapshotDocument['snapshotStyle']; tree: string } | undefined => {
  const normalizedLineEndings = trimmed.replace(/\r\n?/gu, '\n');
  if (normalizedLineEndings.startsWith('```')) {
    const prefixes = ['```yaml\n', '```yml\n'] as const;
    const prefix = prefixes.find((candidate) => normalizedLineEndings.startsWith(candidate));
    if (prefix === undefined || !normalizedLineEndings.endsWith('\n```')) {
      throw new Error('Snapshot uses an unsupported fence.');
    }
    const tree = normalizedLineEndings.slice(prefix.length, -4).trim();
    return tree.length === 0 ? undefined : { style: 'yaml-fence', tree: `${tree}\n` };
  }
  if (/^(?:-\s+)?\[Snapshot\]\([^)]+\)$/u.test(normalizedLineEndings)) return undefined;
  const tree = normalizedLineEndings.trim();
  return tree.length === 0 ? undefined : { style: 'plain', tree: `${tree}\n` };
};

/** One bounded linear scan locates the full inline Snapshot and Page URL. */
export function parseInlineSnapshot(
  sourceText: string,
  counter?: SnapshotScanCounter | undefined,
): InlineSnapshotDocument | undefined {
  assertBoundedText(sourceText);
  let snapshotHeaders = 0;
  let contentStart: number | undefined;
  let sectionEnd: number | undefined;
  const pageUrls: string[] = [];

  forEachLine(sourceText, (line) => {
    if (
      contentStart !== undefined && sectionEnd === undefined &&
      line.start >= contentStart && isSectionHeader(line.text)
    ) sectionEnd = line.start;
    if (exactSnapshotHeader(line.text)) {
      snapshotHeaders += 1;
      if (snapshotHeaders === 1 && line.hasLineBreak) contentStart = line.nextStart;
    }
    const pagePrefix = '- Page URL: ';
    if (line.text.startsWith(pagePrefix) && line.text.length > pagePrefix.length) {
      pageUrls.push(line.text.slice(pagePrefix.length));
    }
  }, counter);

  if (snapshotHeaders === 0 || contentStart === undefined) return undefined;
  if (snapshotHeaders !== 1) throw new Error('Result contains multiple Snapshot sections.');
  if (pageUrls.length > 1) throw new Error('Result contains multiple Page URLs.');
  const rawSection = sourceText.slice(contentStart, sectionEnd ?? sourceText.length);
  const range = trimmedRange(rawSection, counter);
  const parsed = inlineSnapshotTree(rawSection.slice(range.start, range.end));
  if (parsed === undefined) return undefined;
  assertBoundedTree(parsed.tree, counter);
  return Object.freeze({
    schemaVersion: SNAPSHOT_DOCUMENT_VERSION,
    sourceText,
    snapshotTree: parsed.tree,
    snapshotContentStart: contentStart + range.start,
    snapshotContentEnd: contentStart + range.end,
    snapshotStyle: parsed.style,
    ...(pageUrls[0] === undefined ? {} : { pageUrl: pageUrls[0] }),
  });
}

type SnapshotMetadataToken =
  | Readonly<{ kind: 'ref'; start: number; end: number; ref: string }>
  | Readonly<{ kind: 'box'; start: number; end: number; box: SnapshotBox }>
  | Readonly<{ kind: 'malformed'; start: number; end: number }>;

const boundedInteger = (value: string, limit: number): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || Math.abs(parsed) > limit) {
    throw new Error('Snapshot contains an out-of-range box coordinate.');
  }
  return parsed;
};

/** The sole quote/slash/colon-aware ref/box metadata lexer. */
const tokenizeSnapshotMetadataLine = (
  line: string,
  counter?: SnapshotScanCounter | undefined,
): readonly SnapshotMetadataToken[] => {
  const tokens: SnapshotMetadataToken[] = [];
  let quoted = false;
  let slashDelimited = false;
  let escaped = false;
  for (let index = 0; index < line.length;) {
    const character = line[index]!;
    addOperations(counter, 1);
    if (escaped) {
      escaped = false;
      index += 1;
      continue;
    }
    if ((quoted || slashDelimited) && character === '\\') {
      escaped = true;
      index += 1;
      continue;
    }
    if (!slashDelimited && character === '"') {
      quoted = !quoted;
      index += 1;
      continue;
    }
    if (!quoted && character === '/') {
      slashDelimited = !slashDelimited;
      index += 1;
      continue;
    }
    if (quoted || slashDelimited) {
      index += 1;
      continue;
    }
    if (character === ':') break;
    const tokenKind = line.startsWith('[ref=', index)
      ? 'ref'
      : line.startsWith('[box=', index)
        ? 'box'
        : undefined;
    if (tokenKind === undefined) {
      index += 1;
      continue;
    }
    const closing = line.indexOf(']', index + 5);
    const end = closing === -1 ? line.length : closing + 1;
    addOperations(counter, Math.max(0, end - index - 1));
    const payload = closing === -1 ? undefined : line.slice(index + 5, closing);
    if (tokenKind === 'ref' && payload !== undefined && nativeRef.test(payload)) {
      tokens.push(Object.freeze({ kind: 'ref', start: index, end, ref: payload }));
    } else if (tokenKind === 'box' && payload !== undefined) {
      const match = /^(-?\d+),(-?\d+),(\d+),(\d+)$/u.exec(payload);
      if (match === null) {
        tokens.push(Object.freeze({ kind: 'malformed', start: index, end }));
      } else {
        tokens.push(Object.freeze({
          kind: 'box',
          start: index,
          end,
          box: Object.freeze({
            x: boundedInteger(match[1]!, 1_000_000_000),
            y: boundedInteger(match[2]!, 1_000_000_000),
            width: boundedInteger(match[3]!, 1_000_000_000),
            height: boundedInteger(match[4]!, 1_000_000_000),
          }),
        }));
      }
    } else {
      tokens.push(Object.freeze({ kind: 'malformed', start: index, end }));
    }
    index = end;
  }
  return Object.freeze(tokens);
};

const rewriteMetadataLine = (
  line: string,
  replacements: Readonly<{ ref?: string | undefined; box?: string | undefined }>,
): string => {
  const tokens = tokenizeSnapshotMetadataLine(line);
  const parts: string[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.kind === 'malformed') continue;
    const replacement = replacements[token.kind];
    if (replacement === undefined) continue;
    const separator = line[token.start - 1];
    const start = token.kind === 'box' && replacement === '' && token.start > cursor &&
      (separator === ' ' || separator === '\t')
      ? token.start - 1
      : token.start;
    parts.push(line.slice(cursor, start), replacement);
    cursor = token.end;
  }
  if (cursor === 0) return line;
  parts.push(line.slice(cursor));
  return parts.join('');
};

const rewriteSnapshotMetadata = (
  tree: string,
  replacements: Readonly<{ ref?: string | undefined; box?: string | undefined }>,
): string => {
  const lines: string[] = [];
  forEachLine(tree, ({ text }) => lines.push(rewriteMetadataLine(text, replacements)));
  return lines.join('\n');
};

export const stripSnapshotBoxes = (tree: string): string =>
  `${rewriteSnapshotMetadata(tree, { box: '' }).trim()}\n`;

export const snapshotSemanticCommitment = (tree: string): string =>
  rewriteSnapshotMetadata(tree, { ref: '[ref]', box: '' })
    .replace(/[ \t]+$/gmu, '')
    .replace(/\r\n?/gu, '\n');

export const sameSnapshotState = (
  baseline: InlineSnapshotDocument,
  enriched: InlineSnapshotDocument,
): boolean => baseline.pageUrl !== undefined &&
  baseline.pageUrl === enriched.pageUrl &&
  snapshotSemanticCommitment(baseline.snapshotTree) ===
    snapshotSemanticCommitment(enriched.snapshotTree);

const normalized = (value: string): string =>
  value.normalize('NFKC').replace(/\s+/gu, ' ').trim();

const decodeName = (encoded: string | undefined): string | undefined => {
  if (encoded === undefined) return undefined;
  try {
    return JSON.parse(`"${encoded}"`) as string;
  } catch {
    throw new Error('Snapshot contains an invalid quoted accessible name.');
  }
};

export function parseSnapshotNodes(
  tree: string,
  counter?: SnapshotScanCounter | undefined,
): readonly SnapshotNode[] {
  assertBoundedTree(tree, counter);
  const nodes: SnapshotNode[] = [];
  const ancestors: Array<{ indent: number; index: number }> = [];
  forEachLine(tree, ({ text: line }) => {
    const tokens = tokenizeSnapshotMetadataLine(line, counter);
    if (tokens.some(({ kind }) => kind === 'malformed')) {
      throw new Error('Snapshot contains malformed metadata.');
    }
    const match = /^(\s*)-\s+([a-z][a-z0-9-]*)(?:\s+"((?:\\.|[^"\\])*)")?(.*)$/iu.exec(line);
    if (match === null) return;
    if (nodes.length >= MAX_NODES) throw new Error('Snapshot exceeds the node bound.');
    const refs = tokens.filter(
      (token): token is Extract<SnapshotMetadataToken, { kind: 'ref' }> => token.kind === 'ref',
    );
    const boxes = tokens.filter(
      (token): token is Extract<SnapshotMetadataToken, { kind: 'box' }> => token.kind === 'box',
    );
    if (refs.length > 1 || boxes.length > 1) {
      throw new Error('Snapshot node contains duplicate ref or box metadata.');
    }
    const indent = match[1]!.replace(/\t/gu, '  ').length;
    while (ancestors.length > 0 && ancestors.at(-1)!.indent >= indent) ancestors.pop();
    const node: SnapshotNode = Object.freeze({
      index: nodes.length,
      ...(ancestors.at(-1) === undefined ? {} : { parentIndex: ancestors.at(-1)!.index }),
      indent,
      role: match[2]!.toLocaleLowerCase('en-US'),
      ...(match[3] === undefined ? {} : { name: normalized(decodeName(match[3])!) }),
      ...(refs[0] === undefined ? {} : { ref: refs[0].ref }),
      ...(boxes[0] === undefined ? {} : { box: boxes[0].box }),
    });
    nodes.push(node);
    ancestors.push({ indent, index: node.index });
  }, counter);
  return Object.freeze(nodes);
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const ownDataKeys = (value: Record<string, unknown>): readonly string[] => {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new Error('Generated object contains a symbol key.');
  }
  const retained: string[] = [];
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw new Error('Generated object must use enumerable own data properties.');
    }
    retained.push(key);
  }
  return retained;
};

const assertExactRecord: (
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
) => asserts value is Record<string, unknown> = (value, expectedKeys, label) => {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a plain object.`);
  const actual = [...ownDataKeys(value)].sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected properties.`);
  }
};

const assertDenseExactArray: (
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
) => asserts value is unknown[] = (value, minimum, maximum, label) => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a plain array.`);
  }
  if (value.length < minimum || value.length > maximum) {
    throw new Error(`${label} length is outside the bound.`);
  }
  const keys = Reflect.ownKeys(value);
  const expected = new Set<PropertyKey>(['length']);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new Error(`${label} must be dense.`);
    expected.add(String(index));
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw new Error(`${label} entries must be enumerable own data properties.`);
    }
  }
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new Error(`${label} has exotic properties.`);
  }
};

const normalizedAttributeKey = (key: string): string =>
  key.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\s_-]+/gu, '');

export const assertSafeAttributeName = (key: string): void => {
  if (!attributeKey.test(key)) throw new Error('Supplement attribute has an invalid key.');
  const canonical = normalizedAttributeKey(key);
  if (forbiddenSemanticAttribute.has(canonical) || geometryAttributeAliases.has(canonical)) {
    throw new Error('Supplement attribute key is forbidden.');
  }
};

const assertGeneratedString = (value: string): void => {
  if (
    value.length < 1 || value.length > 256 || normalized(value) !== value ||
    unsafeGeneratedCodePoint.test(value) || bidiControl.test(value)
  ) throw new Error('Generated supplement string is not a safe bounded single line.');
  const compact = value.normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\s+/gu, '');
  if (compact.includes('[box=')) {
    throw new Error('Generated supplement string resembles raw box metadata.');
  }
  const normalizedLower = value.normalize('NFKC').toLocaleLowerCase('en-US');
  for (const match of normalizedLower.matchAll(/[a-z][a-z0-9]*/gu)) {
    if (geometryAttributeAliases.has(match[0])) {
      throw new Error('Generated supplement string aliases raw geometry.');
    }
  }
  const numericComponents = normalizedLower.match(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)/gu);
  if (numericComponents !== null && numericComponents.length >= 4) {
    throw new Error('Generated supplement string resembles a raw geometry tuple.');
  }
};

const contractFor = (
  authority: SupplementAuthority,
  schema: string,
): SupplementContract | undefined => authority.supplementContracts.find(
  (contract) => contract.schema === schema,
);

export function renderAdaptiveSnapshot(
  document: InlineSnapshotDocument,
  authoritativeTree: string,
  authoritativeNodes: readonly SnapshotNode[],
  supplement: StructuralSupplement,
  authority: SupplementAuthority,
): string {
  assertExactRecord(supplement, ['schema', 'provenance', 'facts'], 'Structural supplement');
  if (typeof supplement.schema !== 'string' || !boundedVersion.test(supplement.schema)) {
    throw new Error('Structural supplement has an invalid schema.');
  }
  assertExactRecord(supplement.provenance, ['policyId', 'policyVersion'], 'Supplement provenance');
  if (
    supplement.provenance.policyId !== authority.policyId ||
    supplement.provenance.policyVersion !== authority.policyVersion
  ) throw new Error('Structural supplement provenance does not match its first-party policy.');
  const contract = contractFor(authority, supplement.schema);
  if (contract === undefined) throw new Error('Structural supplement schema is not registered.');
  assertDenseExactArray(supplement.facts, 1, 256, 'Structural supplement facts');

  const actionable = new Map<string, SnapshotNode[]>();
  for (const node of authoritativeNodes) {
    if (node.ref === undefined) continue;
    const retained = actionable.get(node.ref) ?? [];
    retained.push(node);
    actionable.set(node.ref, retained);
  }

  const lines: Array<{ identity: string; line: string }> = [];
  for (let factIndex = 0; factIndex < supplement.facts.length; factIndex += 1) {
    const fact = supplement.facts[factIndex]!;
    assertExactRecord(fact, ['kind', 'ref', 'attributes'], 'Structural fact');
    if (
      typeof fact.kind !== 'string' || !boundedCode.test(fact.kind) ||
      typeof fact.ref !== 'string' || !nativeRef.test(fact.ref)
    ) throw new Error('Structural supplement contains an invalid fact identity.');
    const factContract = contract.facts.find(({ kind }) => kind === fact.kind);
    if (factContract === undefined) throw new Error('Structural fact kind is not registered.');
    const matchingNodes = actionable.get(fact.ref);
    if (matchingNodes?.length !== 1 || matchingNodes[0]!.box === undefined) {
      throw new Error('Structural fact ref is not one uniquely actionable boxed node.');
    }
    if (!isPlainRecord(fact.attributes)) {
      throw new Error('Structural fact attributes must be a plain object.');
    }
    const keys = [...ownDataKeys(fact.attributes)].sort();
    if (keys.length < 1 || keys.length > 16) {
      throw new Error('Structural fact attributes are outside the bound.');
    }
    const allowlist = new Set(factContract.attributes);
    const renderedAttributes: string[] = [];
    for (const key of keys) {
      assertSafeAttributeName(key);
      if (!allowlist.has(key)) throw new Error('Structural fact attribute is not registered.');
      const value = fact.attributes[key];
      if (typeof value !== 'string') throw new Error('Structural fact attribute must be text.');
      assertGeneratedString(value);
      renderedAttributes.push(`${key}=${JSON.stringify(value)}`);
    }
    lines.push({
      identity: `${fact.kind}\u0000${fact.ref}`,
      line: `- ${fact.kind} [ref=${fact.ref}] ${renderedAttributes.join(' ')}`,
    });
  }
  lines.sort((left, right) => left.identity.localeCompare(right.identity));
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index - 1]!.identity === lines[index]!.identity) {
      throw new Error('Structural supplement contains duplicate facts.');
    }
  }

  const strippedTree = stripSnapshotBoxes(authoritativeTree);
  const tree = strippedTree.trim();
  const renderedTree = document.snapshotStyle === 'yaml-fence'
    ? `\`\`\`yaml\n${tree}\n\`\`\``
    : tree;
  const replacement = `${renderedTree}\n\n### Adaptive context\n${lines.map(({ line }) => line).join('\n')}`;
  const rendered = `${document.sourceText.slice(0, document.snapshotContentStart)}${replacement}${document.sourceText.slice(document.snapshotContentEnd)}`;
  assertBoundedText(rendered);
  return rendered;
}
