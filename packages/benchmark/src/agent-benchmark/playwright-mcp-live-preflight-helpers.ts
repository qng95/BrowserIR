import type { CallToolResult } from '@modelcontextprotocol/client';

import type { AdaptiveProductAbBroker } from './adaptive-product-ab-broker.js';

export interface ParsedAdaptiveFact {
  readonly kind: string;
  readonly ref: string;
  readonly attributes: Readonly<Record<string, string>>;
}

export const resultText = (result: CallToolResult, label: string): string => {
  if (result.isError === true) throw new Error(`${label} returned an MCP error.`);
  const text = result.content.flatMap((block) =>
    block.type === 'text' ? [block.text] : []).join('\n');
  if (text.length === 0) throw new Error(`${label} returned no text.`);
  return text;
};

export const assertSuccessful = (result: CallToolResult, label: string): void => {
  if (result.isError === true) throw new Error(`${label} returned an MCP error.`);
};

const escapedRegExp = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const loginRef = (result: CallToolResult, role: string, name: string): string => {
  const match = new RegExp(
    `- ${escapedRegExp(role)} "${escapedRegExp(name)}"[^\\n]*\\[ref=([^\\]]+)\\]`,
    'u',
  ).exec(resultText(result, 'Login snapshot'));
  if (match?.[1] === undefined || !/^(?:f[1-9]\d*)?e[1-9]\d*$/u.test(match[1])) {
    throw new Error(`Official MCP login snapshot lacks ${role} ${name}.`);
  }
  return match[1];
};

export const authenticate = async (
  broker: AdaptiveProductAbBroker,
  origin: string,
): Promise<void> => {
  assertSuccessful(await broker.callTool({
    name: 'browser_navigate', arguments: { url: `${origin}/app/login` },
  }), 'Login navigation');
  const snapshot = await broker.callTool({ name: 'browser_snapshot', arguments: {} });
  for (const [label, request] of [
    ['username', {
      name: 'browser_type',
      arguments: {
        target: loginRef(snapshot, 'textbox', 'Username'),
        element: 'Username',
        text: 'test',
      },
    }],
    ['password', {
      name: 'browser_type',
      arguments: {
        target: loginRef(snapshot, 'textbox', 'Password'),
        element: 'Password',
        text: 'test',
      },
    }],
  ] as const) assertSuccessful(await broker.callTool(request), `Login ${label}`);
  assertSuccessful(await broker.callTool({
    name: 'browser_click',
    arguments: {
      target: loginRef(snapshot, 'button', 'Sign in'),
      element: 'Sign in',
    },
  }), 'Login submit');
};

export const parseAdaptiveFacts = (text: string): readonly ParsedAdaptiveFact[] => {
  const normalized = text.replace(/\r\n?/gu, '\n');
  const marker = '### Adaptive context\n';
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) return Object.freeze([]);
  const remainder = normalized.slice(markerIndex + marker.length);
  const nextHeader = remainder.indexOf('\n### ');
  const section = (nextHeader < 0 ? remainder : remainder.slice(0, nextHeader)).trim();
  if (section.length === 0) throw new Error('Adaptive context is empty.');
  return Object.freeze(section.split('\n').map((line): ParsedAdaptiveFact => {
    const match = /^- ([a-z][a-z0-9-]*) \[ref=((?:f[1-9]\d*)?e[1-9]\d*)\] (.+)$/u.exec(line);
    if (match === null) throw new Error('Adaptive context contains a malformed fact.');
    const attributes: Record<string, string> = Object.create(null);
    const source = match[3]!;
    let consumed = '';
    for (const attribute of source.matchAll(/([a-z][a-z0-9-]*)=("(?:\\.|[^"\\])*")(?: |$)/gu)) {
      const key = attribute[1]!;
      if (Object.hasOwn(attributes, key)) throw new Error('Adaptive fact repeats an attribute.');
      attributes[key] = JSON.parse(attribute[2]!) as string;
      consumed += attribute[0];
    }
    if (consumed.trimEnd() !== source || Object.keys(attributes).length === 0) {
      throw new Error('Adaptive fact attributes are malformed.');
    }
    return Object.freeze({
      kind: match[1]!,
      ref: match[2]!,
      attributes: Object.freeze(attributes),
    });
  }));
};
