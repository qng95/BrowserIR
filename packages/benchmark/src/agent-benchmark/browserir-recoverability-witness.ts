import {
  isPlaywrightSnapshotDescendant,
  parsePlaywrightSnapshotNodes,
  type PlaywrightSnapshotBox,
  type PlaywrightSnapshotNode,
} from './playwright-snapshot-document.js';
import type { AdaptiveStructuralFact } from './adaptive-snapshot-policy.js';

export const BROWSERIR_GEOMETRIC_BIJECTION_WITNESS_VERSION =
  'browserir-geometric-bijection-witness/1' as const;

export type BrowserIrGeometricWitnessResult = Readonly<{
  kind: 'resolved' | 'unresolved';
  reasonCode: string;
  facts: readonly AdaptiveStructuralFact[];
}>;

type BoxedNamedNode = PlaywrightSnapshotNode & {
  readonly name: string;
  readonly box: PlaywrightSnapshotBox;
};
type BoxedActionNode = BoxedNamedNode & { readonly ref: string };

const unresolved = (reasonCode: string): BrowserIrGeometricWitnessResult =>
  Object.freeze({ kind: 'unresolved', reasonCode, facts: Object.freeze([]) });

const validBox = (box: PlaywrightSnapshotBox | undefined): box is PlaywrightSnapshotBox =>
  box !== undefined && box.width > 0 && box.height > 0;

const boxedNamed = (node: PlaywrightSnapshotNode): node is BoxedNamedNode =>
  node.name !== undefined && node.name.trim().length > 0 && validBox(node.box);

const descendants = (
  nodes: readonly PlaywrightSnapshotNode[],
  ancestorIndex: number,
): readonly PlaywrightSnapshotNode[] => nodes.filter((node) =>
  isPlaywrightSnapshotDescendant(nodes, node.index, ancestorIndex));

const directChildren = (
  nodes: readonly PlaywrightSnapshotNode[],
  parentIndex: number,
): readonly PlaywrightSnapshotNode[] => nodes.filter(({ parentIndex: parent }) =>
  parent === parentIndex);

const normalizedKey = (value: string): string =>
  value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US');

const uniqueNames = (nodes: readonly BoxedNamedNode[]): boolean =>
  new Set(nodes.map(({ name }) => normalizedKey(name))).size === nodes.length;

const center = (box: PlaywrightSnapshotBox, axis: 'x' | 'y'): number => {
  const size = axis === 'x' ? 'width' : 'height';
  return box[axis] + box[size] / 2;
};

const uniquelyNearest = (
  candidate: PlaywrightSnapshotBox,
  bands: readonly BoxedNamedNode[],
  axis: 'x' | 'y',
): BoxedNamedNode | undefined => {
  const ranked = bands.map((band) => ({
    band,
    distance: Math.abs(center(candidate, axis) - center(band.box, axis)),
  })).sort((left, right) => left.distance - right.distance);
  if (ranked[0] === undefined) return undefined;
  if (ranked[1] !== undefined && ranked[0].distance === ranked[1].distance) return undefined;
  return ranked[0].band;
};

const actionsNamed = (
  nodes: readonly PlaywrightSnapshotNode[],
  actionName: string,
): readonly BoxedActionNode[] => nodes.filter(
  (node): node is BoxedActionNode => node.role === 'button' && node.ref !== undefined &&
    boxedNamed(node) && normalizedKey(node.name) === normalizedKey(actionName),
);

const frozenFacts = (facts: readonly AdaptiveStructuralFact[]):
readonly AdaptiveStructuralFact[] => Object.freeze(facts.map((fact) => Object.freeze({
  ...fact,
  attributes: Object.freeze({ ...fact.attributes }),
})));

const scheduleWitness = (input: {
  nodes: readonly PlaywrightSnapshotNode[];
  actionName: string;
  expectedFactCount: number;
}): BrowserIrGeometricWitnessResult => {
  const roots = input.nodes.filter(({ role }) => role === 'table' || role === 'grid')
    .map((root) => ({ root, inside: descendants(input.nodes, root.index) }))
    .filter(({ inside }) =>
      inside.filter(({ role }) => role === 'rowheader').length >= 2 &&
      inside.filter(({ role }) => role === 'columnheader').length >= 2);
  if (roots.length !== 1) return unresolved('schedule-context-not-unique');
  const resources = roots[0]!.inside.filter(({ role }) => role === 'rowheader')
    .filter(boxedNamed);
  const slots = roots[0]!.inside.filter(({ role }) => role === 'columnheader')
    .filter(boxedNamed);
  const candidates = actionsNamed(input.nodes, input.actionName);
  if (
    resources.length < 2 || slots.length < 2 ||
    resources.length * slots.length !== input.expectedFactCount ||
    candidates.length !== input.expectedFactCount
  ) return unresolved('schedule-cardinality');
  if (!uniqueNames(resources) || !uniqueNames(slots)) {
    return unresolved('schedule-labels-not-unique');
  }
  const facts = candidates.flatMap((candidate): AdaptiveStructuralFact[] => {
    const resource = uniquelyNearest(candidate.box, resources, 'y');
    const slot = uniquelyNearest(candidate.box, slots, 'x');
    return resource === undefined || slot === undefined
      ? []
      : [{
          kind: 'schedule-slot',
          ref: candidate.ref,
          attributes: { resource: resource.name, slot: slot.name },
        }];
  });
  const coordinateKeys = facts.map(({ attributes }) =>
    `${normalizedKey(attributes['resource']!)}\u0000${normalizedKey(attributes['slot']!)}`);
  if (
    facts.length !== input.expectedFactCount ||
    new Set(facts.map(({ ref }) => ref)).size !== input.expectedFactCount ||
    new Set(coordinateKeys).size !== input.expectedFactCount
  ) return unresolved('schedule-nearest-centre-not-complete-bijection');
  return Object.freeze({
    kind: 'resolved',
    reasonCode: 'schedule-nearest-centre-complete-bijection',
    facts: frozenFacts(facts),
  });
};

const crossTreeWitness = (input: {
  nodes: readonly PlaywrightSnapshotNode[];
  actionName: string;
  expectedFactCount: number;
}): BrowserIrGeometricWitnessResult => {
  const contexts = input.nodes.filter(({ role }) => role === 'region' || role === 'form')
    .flatMap((root) => {
      const containers = directChildren(input.nodes, root.index)
        .filter(({ role }) => role === 'group' || role === 'list')
        .map((container) => ({
          container,
          inside: descendants(input.nodes, container.index),
        }));
      const labelContainers = containers.filter(({ inside }) =>
        inside.filter(({ role }) => role === 'heading' || role === 'term').length ===
          input.expectedFactCount &&
        actionsNamed(inside, input.actionName).length === 0);
      const controlContainers = containers.filter(({ inside }) =>
        inside.filter(({ role }) => role === 'heading' || role === 'term').length === 0 &&
        actionsNamed(inside, input.actionName).length === input.expectedFactCount);
      return labelContainers.length === 1 && controlContainers.length === 1
        ? [{ labels: labelContainers[0]!.inside, controls: controlContainers[0]!.inside }]
        : [];
    });
  if (contexts.length !== 1) return unresolved('cross-tree-context-not-unique');
  const labels = contexts[0]!.labels
    .filter(({ role }) => role === 'heading' || role === 'term')
    .filter(boxedNamed);
  const candidates = actionsNamed(contexts[0]!.controls, input.actionName);
  if (
    labels.length !== input.expectedFactCount ||
    candidates.length !== input.expectedFactCount
  ) return unresolved('cross-tree-cardinality');
  if (!uniqueNames(labels)) return unresolved('cross-tree-labels-not-unique');
  const facts = candidates.flatMap((candidate): AdaptiveStructuralFact[] => {
    const label = uniquelyNearest(candidate.box, labels, 'y');
    return label === undefined
      ? []
      : [{
          kind: 'cross-tree-label',
          ref: candidate.ref,
          attributes: { label: label.name },
        }];
  });
  if (
    facts.length !== input.expectedFactCount ||
    new Set(facts.map(({ ref }) => ref)).size !== input.expectedFactCount ||
    new Set(facts.map(({ attributes }) => normalizedKey(attributes['label']!))).size !==
      input.expectedFactCount
  ) return unresolved('cross-tree-nearest-centre-not-complete-bijection');
  return Object.freeze({
    kind: 'resolved',
    reasonCode: 'cross-tree-nearest-centre-complete-bijection',
    facts: frozenFacts(facts),
  });
};

/**
 * Evaluation-only witness. It constructs a complete relation from geometry,
 * without reading the requested target or the fixture oracle.
 */
export function witnessBrowserIrGeometricRecoverability(input: Readonly<{
  family: 'schedule-coordinate' | 'cross-tree-label';
  snapshotTree: string;
  actionName: string;
  expectedFactCount: number;
}>): BrowserIrGeometricWitnessResult {
  if (!Number.isSafeInteger(input.expectedFactCount) || input.expectedFactCount < 2) {
    throw new Error('Geometric witness expectedFactCount must be at least two.');
  }
  const nodes = parsePlaywrightSnapshotNodes(input.snapshotTree);
  return input.family === 'schedule-coordinate'
    ? scheduleWitness({ nodes, actionName: input.actionName,
        expectedFactCount: input.expectedFactCount })
    : crossTreeWitness({ nodes, actionName: input.actionName,
        expectedFactCount: input.expectedFactCount });
}
