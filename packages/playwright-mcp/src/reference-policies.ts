import { types as nodeUtilTypes } from 'node:util';

import {
  createInternalPolicySetWithMetadata,
  type AdaptivePlaywrightPolicySet,
  type InternalPolicyDecision,
  type InternalPolicyEvaluationContext,
  type InternalPolicyProjection,
  type InternalPolicyProjectionContext,
  type InternalPolicySetDefinition,
} from './internal/policy-set.js';
import {
  createScheduleProjectionDiagnosticChannel,
  type ScheduleProjectionDiagnosticReason,
} from './internal/schedule-projection-diagnostic-state.js';
import type {
  SnapshotBox,
  SnapshotNode,
  StructuralFact,
  StructuralSupplement,
} from './internal/snapshot.js';

export const ADAPTIVE_REFERENCE_POLICIES_VERSION =
  'adaptive-reference-policies/1' as const;

export type AdaptivePlaywrightReferencePolicyFamily =
  | 'grid-coordinate'
  | 'schedule-coordinate'
  | 'cross-tree-label';

export type AdaptivePlaywrightReferencePolicyVersion =
  | 'grid-coordinate-policy/1'
  | 'schedule-coordinate-policy/3'
  | 'cross-tree-label-policy/1';

interface CommonReferencePolicySupport<
  Schema extends string,
  FactKind extends string,
  Attributes extends readonly string[],
  Limits extends object,
> {
  readonly feature: 'geometry';
  readonly schema: Schema;
  readonly factKind: FactKind;
  readonly attributes: Attributes;
  readonly completeOrNone: true;
  readonly refSource: 'current-boxed-snapshot';
  readonly minimumFacts: number;
  readonly maximumFacts: number;
  readonly limits: Readonly<Limits>;
}

export type GridCoordinateReferencePolicySupport = CommonReferencePolicySupport<
  'grid-coordinate/1',
  'grid-cell',
  readonly ['row', 'column'],
  Readonly<{
    minimumRows: 2;
    maximumRows: number;
    minimumColumns: 2;
    maximumColumns: number;
  }>
>;

export type ScheduleCoordinateReferencePolicySupport = CommonReferencePolicySupport<
  'schedule-coordinate/1',
  'schedule-slot',
  readonly ['resource', 'slot'],
  Readonly<{
    minimumResources: 2;
    maximumResources: 12;
    minimumSlots: 2;
    maximumSlots: 12;
  }>
>;

export type CrossTreeLabelReferencePolicySupport = CommonReferencePolicySupport<
  'cross-tree-label/1',
  'cross-tree-label',
  readonly ['label'],
  Readonly<{ labels: 2; controls: 2 }>
>;

export type AdaptivePlaywrightReferencePolicySupport =
  | GridCoordinateReferencePolicySupport
  | ScheduleCoordinateReferencePolicySupport
  | CrossTreeLabelReferencePolicySupport;

/**
 * A first-party handle accepted directly by `createAdaptivePlaywrightTools`.
 * Its only runtime surface is inert, frozen support metadata.
 */
export interface AdaptivePlaywrightReferencePolicySet<
  Family extends AdaptivePlaywrightReferencePolicyFamily =
    AdaptivePlaywrightReferencePolicyFamily,
  Version extends AdaptivePlaywrightReferencePolicyVersion =
    AdaptivePlaywrightReferencePolicyVersion,
  Support extends AdaptivePlaywrightReferencePolicySupport =
    AdaptivePlaywrightReferencePolicySupport,
> extends AdaptivePlaywrightPolicySet {
  readonly family: Family;
  readonly version: Version;
  readonly support: Support;
}

export type GridCoordinateReferencePolicy = AdaptivePlaywrightReferencePolicySet<
  'grid-coordinate',
  'grid-coordinate-policy/1',
  GridCoordinateReferencePolicySupport
>;

export type ScheduleCoordinateReferencePolicy = AdaptivePlaywrightReferencePolicySet<
  'schedule-coordinate',
  'schedule-coordinate-policy/3',
  ScheduleCoordinateReferencePolicySupport
>;

export type CrossTreeLabelReferencePolicy = AdaptivePlaywrightReferencePolicySet<
  'cross-tree-label',
  'cross-tree-label-policy/1',
  CrossTreeLabelReferencePolicySupport
>;

export interface GridCoordinateReferencePolicyOptions {
  readonly maxRows?: number | undefined;
  readonly maxColumns?: number | undefined;
}

type NamedNode = SnapshotNode & { readonly name: string };
type ActionNode = SnapshotNode & { readonly name: string; readonly ref: string };
type BoxedNode<Node extends SnapshotNode = SnapshotNode> = Node & { readonly box: SnapshotBox };
type ReferenceFamilyAnalysis = GridAnalysis | ScheduleAnalysis | CrossTreeAnalysis;

interface GridShape {
  readonly family: 'grid-coordinate';
  readonly root: SnapshotNode;
  readonly rows: readonly NamedNode[];
  readonly columns: readonly NamedNode[];
}

interface GridAnalysis extends GridShape {
  readonly route: 'sufficient' | 'geometry';
  readonly candidates: readonly ActionNode[];
}

interface ScheduleShape {
  readonly family: 'schedule-coordinate';
  readonly root: SnapshotNode;
  readonly resources: readonly NamedNode[];
  readonly slots: readonly NamedNode[];
}

interface ScheduleAnalysis extends ScheduleShape {
  readonly route: 'sufficient' | 'geometry';
  readonly candidates: readonly ActionNode[];
}

interface CrossTreeShape {
  readonly family: 'cross-tree-label';
  readonly root: SnapshotNode;
  readonly labelContainer: SnapshotNode;
  readonly controlContainer: SnapshotNode;
  readonly labels: readonly NamedNode[];
}

interface CrossTreeAnalysis extends CrossTreeShape {
  readonly route: 'sufficient' | 'geometry';
  readonly candidates: readonly ActionNode[];
}

interface FamilyContexts {
  readonly grid: readonly GridShape[];
  readonly schedule: readonly ScheduleShape[];
  readonly crossTree: readonly CrossTreeShape[];
}

interface GridLimits {
  readonly maxRows: number;
  readonly maxColumns: number;
}

const PASSTHROUGH: InternalPolicyDecision = Object.freeze({ kind: 'passthrough' });
const CAPTURE_BOXES: InternalPolicyDecision = Object.freeze({ kind: 'capture-boxes' });
const UNRESOLVED: InternalPolicyProjection = Object.freeze({ kind: 'unresolved' });
const MAX_REFERENCE_CONTEXT_ROOTS = 32;
const MAX_REFERENCE_ACTION_NODES = 1_024;
const MAX_CROSS_TREE_CONTAINERS_PER_ROOT = 16;

const normalized = (value: string): string =>
  value.normalize('NFKC').replace(/\s+/gu, ' ').trim();

const normalizedKey = (value: string): string =>
  normalized(value).toLocaleLowerCase('en-US');

const labelOccurs = (name: string, label: string): boolean => {
  const haystack = ` ${normalizedKey(name)} `;
  const needle = ` ${normalizedKey(label)} `;
  return haystack.includes(needle);
};

const isDescendant = (
  nodes: readonly SnapshotNode[],
  candidateIndex: number,
  ancestorIndex: number,
): boolean => {
  let parent = nodes[candidateIndex]?.parentIndex;
  while (parent !== undefined) {
    if (parent === ancestorIndex) return true;
    parent = nodes[parent]?.parentIndex;
  }
  return false;
};

const descendants = (
  nodes: readonly SnapshotNode[],
  ancestorIndex: number,
): readonly SnapshotNode[] => nodes.filter((node) =>
  isDescendant(nodes, node.index, ancestorIndex));

const directChildren = (
  nodes: readonly SnapshotNode[],
  parentIndex: number,
): readonly SnapshotNode[] => nodes.filter((node) => node.parentIndex === parentIndex);

const exactUniqueNamed = (
  nodes: readonly SnapshotNode[],
): readonly NamedNode[] | undefined => {
  const retained: NamedNode[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.name === undefined || normalized(node.name).length === 0) return undefined;
    const key = normalizedKey(node.name);
    if (seen.has(key)) return undefined;
    seen.add(key);
    retained.push(node as NamedNode);
  }
  return retained;
};

const actionNodes = (nodes: readonly SnapshotNode[]): readonly ActionNode[] => nodes.filter(
  (node): node is ActionNode =>
    node.role === 'button' && node.name !== undefined && node.ref !== undefined,
);

const groupsByName = (nodes: readonly ActionNode[]): readonly (readonly ActionNode[])[] => {
  const groups = new Map<string, ActionNode[]>();
  for (const node of nodes) {
    const key = normalizedKey(node.name);
    const group = groups.get(key) ?? [];
    group.push(node);
    groups.set(key, group);
  }
  return [...groups.values()];
};

const completeSemanticBindings = (
  candidates: readonly ActionNode[],
  first: readonly NamedNode[],
  second: readonly NamedNode[],
): boolean => {
  const coordinates = candidates.flatMap(({ name }) => {
    const firstMatches = first.filter((label) => labelOccurs(name, label.name));
    const secondMatches = second.filter((label) => labelOccurs(name, label.name));
    return firstMatches.length === 1 && secondMatches.length === 1
      ? [`${firstMatches[0]!.name}\u0000${secondMatches[0]!.name}`]
      : [];
  });
  const expected = first.flatMap((left) => second.map((right) =>
    `${left.name}\u0000${right.name}`));
  return candidates.length === expected.length &&
    coordinates.length === expected.length &&
    new Set(coordinates).size === expected.length &&
    expected.every((coordinate) => coordinates.includes(coordinate));
};

const timeLike = /(?:^|\s)(?:[01]\d|2[0-3]):[0-5]\d(?:\s|$)/u;
const virtualIdentityMetadata =
  /\[(?:aria-)?(?:rowcount|rowindex|colcount|colindex|setsize|posinset)=/iu;

const scheduleShapes = (nodes: readonly SnapshotNode[]): readonly ScheduleShape[] => {
  const shapes: ScheduleShape[] = [];
  for (const root of nodes.filter(({ role }) => role === 'table' || role === 'grid')) {
    const inside = descendants(nodes, root.index);
    const resources = exactUniqueNamed(inside.filter(({ role }) => role === 'rowheader'));
    const slots = exactUniqueNamed(inside.filter(({ role }) => role === 'columnheader'));
    if (
      resources === undefined || slots === undefined ||
      resources.length < 2 || resources.length > 12 ||
      slots.length < 2 || slots.length > 12 ||
      resources.length * slots.length > 64 ||
      !slots.every(({ name }) => timeLike.test(normalized(name)))
    ) continue;
    shapes.push({ family: 'schedule-coordinate', root, resources, slots });
  }
  return shapes;
};

const gridShapes = (
  nodes: readonly SnapshotNode[],
  limits: GridLimits,
  claimedScheduleRoots: ReadonlySet<number>,
): readonly GridShape[] => {
  const shapes: GridShape[] = [];
  for (const root of nodes.filter(({ role }) => role === 'grid')) {
    if (claimedScheduleRoots.has(root.index)) continue;
    const inside = descendants(nodes, root.index);
    const rows = exactUniqueNamed(inside.filter(({ role }) => role === 'rowheader'));
    const columns = exactUniqueNamed(inside.filter(({ role }) => role === 'columnheader'));
    if (
      rows === undefined || columns === undefined ||
      rows.length < 2 || rows.length > limits.maxRows ||
      columns.length < 2 || columns.length > limits.maxColumns
    ) continue;
    shapes.push({ family: 'grid-coordinate', root, rows, columns });
  }
  return shapes;
};

const crossTreeShapes = (nodes: readonly SnapshotNode[]): readonly CrossTreeShape[] => {
  const shapes: CrossTreeShape[] = [];
  for (const root of nodes.filter(({ role }) => role === 'region' || role === 'form')) {
    const containers = directChildren(nodes, root.index)
      .filter(({ role }) => role === 'group' || role === 'list');
    const analyses = containers.map((container) => {
      const inside = descendants(nodes, container.index);
      return {
        container,
        labels: exactUniqueNamed(inside.filter(({ role }) =>
          role === 'heading' || role === 'term')),
        candidates: actionNodes(inside),
      };
    });
    const labelContainers = analyses.filter(({ labels, candidates }) =>
      labels?.length === 2 && candidates.length === 0);
    const controlContainers = analyses.filter(({ labels, candidates }) =>
      (labels?.length ?? 0) === 0 && candidates.length === 2);
    if (labelContainers.length !== 1 || controlContainers.length !== 1) continue;
    shapes.push({
      family: 'cross-tree-label',
      root,
      labelContainer: labelContainers[0]!.container,
      controlContainer: controlContainers[0]!.container,
      labels: labelContainers[0]!.labels!,
    });
  }
  return shapes;
};

const familyContexts = (
  snapshotTree: string,
  nodes: readonly SnapshotNode[],
  limits: GridLimits,
): FamilyContexts | undefined => {
  if (virtualIdentityMetadata.test(snapshotTree)) return undefined;
  const contextRoots = nodes.filter(({ role }) =>
    role === 'table' || role === 'grid' || role === 'region' || role === 'form');
  if (
    contextRoots.length > MAX_REFERENCE_CONTEXT_ROOTS ||
    actionNodes(nodes).length > MAX_REFERENCE_ACTION_NODES ||
    contextRoots.some((root) =>
      (root.role === 'region' || root.role === 'form') &&
      directChildren(nodes, root.index).filter(({ role }) =>
        role === 'group' || role === 'list').length > MAX_CROSS_TREE_CONTAINERS_PER_ROOT)
  ) return undefined;
  const schedule = scheduleShapes(nodes);
  const grid = gridShapes(nodes, limits, new Set(schedule.map(({ root }) => root.index)));
  const crossTree = crossTreeShapes(nodes);
  const presentFamilies = [grid, schedule, crossTree].filter((shapes) => shapes.length > 0);
  if (
    presentFamilies.length !== 1 ||
    grid.length > 1 || schedule.length > 1 || crossTree.length > 1
  ) return undefined;
  return { grid, schedule, crossTree };
};

const analyzeGrid = (
  shape: GridShape,
  nodes: readonly SnapshotNode[],
): GridAnalysis | undefined => {
  const buttons = actionNodes(nodes);
  const expectedCount = shape.rows.length * shape.columns.length;
  const semantic = buttons.filter(({ name }) => {
    const rowMatches = shape.rows.filter((row) => labelOccurs(name, row.name));
    const columnMatches = shape.columns.filter((column) => labelOccurs(name, column.name));
    return rowMatches.length === 1 && columnMatches.length === 1;
  });
  const semanticComplete = completeSemanticBindings(semantic, shape.rows, shape.columns);
  const ambiguous = groupsByName(buttons).filter((group) =>
    group.length === expectedCount &&
    new Set(group.map(({ ref }) => ref)).size === expectedCount);
  if (semanticComplete && ambiguous.length === 0) {
    return { ...shape, route: 'sufficient', candidates: semantic };
  }
  if (!semanticComplete && ambiguous.length === 1) {
    return { ...shape, route: 'geometry', candidates: ambiguous[0]! };
  }
  return undefined;
};

const analyzeSchedule = (
  shape: ScheduleShape,
  nodes: readonly SnapshotNode[],
): ScheduleAnalysis | undefined => {
  const outsideButtons = actionNodes(nodes).filter((button) =>
    !isDescendant(nodes, button.index, shape.root.index));
  const expectedCount = shape.resources.length * shape.slots.length;
  const semantic = outsideButtons.filter(({ name }) => {
    const resourceMatches = shape.resources.filter((resource) => labelOccurs(name, resource.name));
    const slotMatches = shape.slots.filter((slot) => labelOccurs(name, slot.name));
    return resourceMatches.length === 1 && slotMatches.length === 1;
  });
  const semanticComplete = completeSemanticBindings(semantic, shape.resources, shape.slots);
  const ambiguous = groupsByName(outsideButtons).filter((group) =>
    group.length === expectedCount &&
    new Set(group.map(({ ref }) => ref)).size === expectedCount);
  if (semanticComplete && ambiguous.length === 0) {
    return { ...shape, route: 'sufficient', candidates: semantic };
  }
  if (!semanticComplete && ambiguous.length === 1) {
    return { ...shape, route: 'geometry', candidates: ambiguous[0]! };
  }
  return undefined;
};

const analyzeCrossTree = (
  shape: CrossTreeShape,
  nodes: readonly SnapshotNode[],
): CrossTreeAnalysis | undefined => {
  const candidates = actionNodes(descendants(nodes, shape.controlContainer.index));
  const semantic = candidates.filter(({ name }) =>
    shape.labels.filter((label) => labelOccurs(name, label.name)).length === 1);
  const semanticComplete = semantic.length === shape.labels.length &&
    shape.labels.every((label) => semantic.filter(({ name }) =>
      labelOccurs(name, label.name)).length === 1);
  const ambiguous = groupsByName(candidates).filter((group) =>
    group.length === shape.labels.length &&
    new Set(group.map(({ ref }) => ref)).size === shape.labels.length);
  if (semanticComplete && ambiguous.length === 0) {
    return { ...shape, route: 'sufficient', candidates: semantic };
  }
  if (!semanticComplete && ambiguous.length === 1) {
    return { ...shape, route: 'geometry', candidates: ambiguous[0]! };
  }
  return undefined;
};

const analysisFor = (
  family: AdaptivePlaywrightReferencePolicyFamily,
  snapshotTree: string,
  nodes: readonly SnapshotNode[],
  limits: GridLimits,
): ReferenceFamilyAnalysis | undefined => {
  if (
    family === 'grid-coordinate' &&
    nodes.filter(({ role }) => role === 'grid').length !== 1
  ) return undefined;
  const contexts = familyContexts(snapshotTree, nodes, limits);
  if (contexts === undefined) return undefined;
  switch (family) {
    case 'grid-coordinate':
      return contexts.grid[0] === undefined ? undefined : analyzeGrid(contexts.grid[0], nodes);
    case 'schedule-coordinate':
      return contexts.schedule[0] === undefined
        ? undefined
        : analyzeSchedule(contexts.schedule[0], nodes);
    case 'cross-tree-label':
      return contexts.crossTree[0] === undefined
        ? undefined
        : analyzeCrossTree(contexts.crossTree[0], nodes);
  }
};

const validBox = (box: SnapshotBox): boolean => box.width > 0 && box.height > 0;

const withValidBox = <Node extends SnapshotNode>(node: Node): node is BoxedNode<Node> =>
  node.box !== undefined && validBox(node.box);

const axisInside = (
  candidate: SnapshotBox,
  band: SnapshotBox,
  axis: 'x' | 'y',
): boolean => {
  const size = axis === 'x' ? 'width' : 'height';
  return candidate[axis] >= band[axis] &&
    candidate[axis] + candidate[size] <= band[axis] + band[size];
};

const centerWithin = (
  candidate: SnapshotBox,
  band: SnapshotBox,
  axis: 'x' | 'y',
): boolean => {
  const size = axis === 'x' ? 'width' : 'height';
  const center = candidate[axis] + candidate[size] / 2;
  return center >= band[axis] && center < band[axis] + band[size];
};

const minimumAdjacentCenterDistance = (
  bands: readonly SnapshotBox[],
  axis: 'x' | 'y',
): number | undefined => {
  const size = axis === 'x' ? 'width' : 'height';
  const centers = bands
    .map((band) => band[axis] + band[size] / 2)
    .sort((left, right) => left - right);
  if (centers.length < 2) return undefined;
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < centers.length; index += 1) {
    minimum = Math.min(minimum, centers[index]! - centers[index - 1]!);
  }
  return Number.isFinite(minimum) && minimum > 0 ? minimum : undefined;
};

const boxInside = (inner: SnapshotBox, outer: SnapshotBox): boolean =>
  inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

// Browser box serialization can expose a one-pixel border-rounding overhang
// for the final row of an otherwise contained schedule grid (notably RTL CSS
// grids). Keep this tolerance local to schedule resource/root containment;
// every center, overlap, completeness, and uniqueness guard remains strict.
const boxInsideWithSerializedEdgeTolerance = (
  inner: SnapshotBox,
  outer: SnapshotBox,
): boolean =>
  inner.x >= outer.x - 1 && inner.y >= outer.y - 1 &&
  inner.x + inner.width <= outer.x + outer.width + 1 &&
  inner.y + inner.height <= outer.y + outer.height + 1;

const bandsDoNotOverlap = (
  boxes: readonly SnapshotBox[],
  axis: 'x' | 'y',
): boolean => {
  const size = axis === 'x' ? 'width' : 'height';
  const ordered = [...boxes].sort((left, right) => left[axis] - right[axis]);
  return ordered.every((box, index) => index === 0 ||
    ordered[index - 1]![axis] + ordered[index - 1]![size] <= box[axis]);
};

const maximumPositiveAxisOverlap = (
  boxes: readonly SnapshotBox[],
  axis: 'x' | 'y',
): number => {
  const size = axis === 'x' ? 'width' : 'height';
  const ordered = [...boxes].sort((left, right) => left[axis] - right[axis]);
  let maximum = 0;
  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
    const left = ordered[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
      const right = ordered[rightIndex]!;
      const overlap = Math.min(
        left[axis] + left[size],
        right[axis] + right[size],
      ) - Math.max(left[axis], right[axis]);
      maximum = Math.max(maximum, overlap);
    }
  }
  return maximum;
};

const boxesDoNotOverlap = (boxes: readonly SnapshotBox[]): boolean =>
  boxes.every((left, leftIndex) => boxes.every((right, rightIndex) =>
    rightIndex <= leftIndex ||
    left.x + left.width <= right.x || right.x + right.width <= left.x ||
    left.y + left.height <= right.y || right.y + right.height <= left.y));

const positiveAxisOverlap = (
  left: SnapshotBox,
  right: SnapshotBox,
  axis: 'x' | 'y',
): boolean => {
  const size = axis === 'x' ? 'width' : 'height';
  return left[axis] < right[axis] + right[size] &&
    right[axis] < left[axis] + left[size];
};

const nearestAncestorWithRole = (
  nodes: readonly SnapshotNode[],
  candidate: SnapshotNode,
  roles: ReadonlySet<string>,
): SnapshotNode | undefined => {
  let parent = candidate.parentIndex;
  while (parent !== undefined) {
    const node = nodes[parent];
    if (node === undefined) return undefined;
    if (roles.has(node.role)) return node;
    parent = node.parentIndex;
  }
  return undefined;
};

const gridFacts = (
  analysis: GridAnalysis,
  nodes: readonly SnapshotNode[],
): readonly StructuralFact[] | undefined => {
  if (!withValidBox(analysis.root)) return undefined;
  const rootBox = analysis.root.box;
  const rows = analysis.rows.filter(withValidBox);
  const columns = analysis.columns.filter(withValidBox);
  const candidates = analysis.candidates.filter(withValidBox);
  if (
    rows.length !== analysis.rows.length ||
    columns.length !== analysis.columns.length ||
    candidates.length !== analysis.candidates.length
  ) return undefined;
  const rowAncestors = rows.map((row) => nearestAncestorWithRole(nodes, row, new Set(['row']))?.index);
  const columnAncestors = columns.map((column) =>
    nearestAncestorWithRole(nodes, column, new Set(['row']))?.index);
  if (
    rowAncestors.some((index) => index === undefined) ||
    new Set(rowAncestors).size !== rows.length ||
    columnAncestors.some((index) => index === undefined) ||
    new Set(columnAncestors).size !== 1 ||
    !bandsDoNotOverlap(rows.map(({ box }) => box), 'y') ||
    !bandsDoNotOverlap(columns.map(({ box }) => box), 'x') ||
    !boxesDoNotOverlap(candidates.map(({ box }) => box)) ||
    ![...rows, ...columns, ...candidates].every(({ box }) => boxInside(box, rootBox))
  ) return undefined;
  const facts = candidates.flatMap((candidate): StructuralFact[] => {
    const matchingRows = rows.filter((row) => axisInside(candidate.box, row.box, 'y'));
    const matchingColumns = columns.filter((column) =>
      axisInside(candidate.box, column.box, 'x'));
    return matchingRows.length === 1 && matchingColumns.length === 1
      ? [{
          kind: 'grid-cell',
          ref: candidate.ref,
          attributes: Object.freeze({
            row: matchingRows[0]!.name,
            column: matchingColumns[0]!.name,
          }),
        }]
      : [];
  });
  const expectedCount = rows.length * columns.length;
  const coordinates = facts.map(({ attributes }) =>
    `${attributes.row}\u0000${attributes.column}`);
  if (
    facts.length !== expectedCount ||
    new Set(facts.map(({ ref }) => ref)).size !== expectedCount ||
    new Set(coordinates).size !== expectedCount
  ) return undefined;
  return Object.freeze(facts.map((fact) => Object.freeze(fact)));
};

interface ScheduleProjectionFactsOutcome {
  readonly reason: ScheduleProjectionDiagnosticReason;
  readonly facts?: readonly StructuralFact[] | undefined;
}

const unresolvedScheduleProjection = (
  reason: Exclude<ScheduleProjectionDiagnosticReason, 'resolved'>,
): ScheduleProjectionFactsOutcome => ({ reason });

const scheduleFacts = (analysis: ScheduleAnalysis): ScheduleProjectionFactsOutcome => {
  if (!withValidBox(analysis.root)) return unresolvedScheduleProjection('root-box');
  const rootBox = analysis.root.box;
  const resources = analysis.resources.filter(withValidBox);
  const slots = analysis.slots.filter(withValidBox);
  const candidates = analysis.candidates.filter(withValidBox);
  if (resources.length !== analysis.resources.length) {
    return unresolvedScheduleProjection('resource-box');
  }
  if (slots.length !== analysis.slots.length) {
    return unresolvedScheduleProjection('slot-box');
  }
  if (candidates.length !== analysis.candidates.length) {
    return unresolvedScheduleProjection('candidate-box');
  }
  if (!bandsDoNotOverlap(resources.map(({ box }) => box), 'y')) {
    return unresolvedScheduleProjection('resource-bands');
  }
  const maximumSlotOverlap = maximumPositiveAxisOverlap(slots.map(({ box }) => box), 'x');
  if (maximumSlotOverlap > 1) {
    return unresolvedScheduleProjection('slot-bands-overlap-material');
  }
  if (!boxesDoNotOverlap(candidates.map(({ box }) => box))) {
    return unresolvedScheduleProjection('candidate-overlap');
  }
  if (!resources.every(({ box }) => boxInsideWithSerializedEdgeTolerance(box, rootBox))) {
    return unresolvedScheduleProjection('resources-inside-root');
  }
  if (!slots.every(({ box }) => boxInside(box, rootBox))) {
    return unresolvedScheduleProjection('slots-inside-root');
  }
  if (!candidates.every(({ box }) => boxInside(box, rootBox))) {
    return unresolvedScheduleProjection('candidates-inside-root');
  }
  const resourceCenterDistance = minimumAdjacentCenterDistance(
    resources.map(({ box }) => box),
    'y',
  );
  const slotCenterDistance = minimumAdjacentCenterDistance(
    slots.map(({ box }) => box),
    'x',
  );
  if (resourceCenterDistance === undefined) {
    return unresolvedScheduleProjection('resource-center-distance');
  }
  if (slotCenterDistance === undefined) {
    return unresolvedScheduleProjection('slot-center-distance');
  }
  for (const { box } of candidates) {
    if (box.height >= resourceCenterDistance) {
      return unresolvedScheduleProjection('candidate-height-spacing');
    }
  }
  const bindings = candidates.flatMap((candidate) => {
    const matchingResources = resources.filter((resource) =>
      centerWithin(candidate.box, resource.box, 'y'));
    const matchingSlots = slots.filter((slot) => centerWithin(candidate.box, slot.box, 'x'));
    return matchingResources.length === 1 && matchingSlots.length === 1
      ? [{
          candidate,
          resource: matchingResources[0]!,
          slot: matchingSlots[0]!,
        }]
      : [];
  });
  const expectedCount = resources.length * slots.length;
  if (bindings.length !== expectedCount) return unresolvedScheduleProjection('fact-count');
  if (bindings.some(({ candidate, slot }) => slots.some((other) =>
    other.index !== slot.index && positiveAxisOverlap(candidate.box, other.box, 'x')))) {
    return unresolvedScheduleProjection('candidate-cross-slot');
  }
  const facts: readonly StructuralFact[] = bindings.map(({ candidate, resource, slot }) => ({
    kind: 'schedule-slot',
    ref: candidate.ref,
    attributes: Object.freeze({ resource: resource.name, slot: slot.name }),
  }));
  const coordinates = facts.map(({ attributes }) =>
    `${attributes.resource}\u0000${attributes.slot}`);
  if (new Set(facts.map(({ ref }) => ref)).size !== expectedCount) {
    return unresolvedScheduleProjection('unique-ref');
  }
  if (new Set(coordinates).size !== expectedCount) {
    return unresolvedScheduleProjection('unique-coordinate');
  }
  return {
    reason: 'resolved',
    facts: Object.freeze(facts.map((fact) => Object.freeze(fact))),
  };
};

const crossTreeFacts = (analysis: CrossTreeAnalysis): readonly StructuralFact[] | undefined => {
  if (
    !withValidBox(analysis.root) ||
    !withValidBox(analysis.labelContainer) ||
    !withValidBox(analysis.controlContainer)
  ) return undefined;
  const rootBox = analysis.root.box;
  const labelContainerBox = analysis.labelContainer.box;
  const controlContainerBox = analysis.controlContainer.box;
  const labels = analysis.labels.filter(withValidBox);
  const candidates = analysis.candidates.filter(withValidBox);
  if (
    labels.length !== analysis.labels.length ||
    candidates.length !== analysis.candidates.length ||
    !bandsDoNotOverlap(labels.map(({ box }) => box), 'y') ||
    !bandsDoNotOverlap(candidates.map(({ box }) => box), 'y') ||
    !boxesDoNotOverlap(candidates.map(({ box }) => box)) ||
    !labels.every(({ box }) => boxInside(box, labelContainerBox)) ||
    !candidates.every(({ box }) => boxInside(box, controlContainerBox)) ||
    !boxInside(labelContainerBox, rootBox) ||
    !boxInside(controlContainerBox, rootBox)
  ) return undefined;
  const facts = candidates.flatMap((candidate): StructuralFact[] => {
    const matching = labels.filter((label) => axisInside(candidate.box, label.box, 'y'));
    return matching.length === 1
      ? [{
          kind: 'cross-tree-label',
          ref: candidate.ref,
          attributes: Object.freeze({ label: matching[0]!.name }),
        }]
      : [];
  });
  if (
    facts.length !== labels.length ||
    new Set(facts.map(({ ref }) => ref)).size !== labels.length ||
    new Set(facts.map(({ attributes }) => attributes.label)).size !== labels.length
  ) return undefined;
  return Object.freeze(facts.map((fact) => Object.freeze(fact)));
};

const factsFor = (
  analysis: ReferenceFamilyAnalysis,
  nodes: readonly SnapshotNode[],
): readonly StructuralFact[] | undefined => {
  switch (analysis.family) {
    case 'grid-coordinate': return gridFacts(analysis, nodes);
    case 'schedule-coordinate': return scheduleFacts(analysis).facts;
    case 'cross-tree-label': return crossTreeFacts(analysis);
  }
};

const resolvedProjection = (
  policyId: AdaptivePlaywrightReferencePolicyFamily,
  policyVersion: AdaptivePlaywrightReferencePolicyVersion,
  schema: string,
  facts: readonly StructuralFact[],
): InternalPolicyProjection => {
  const supplement: StructuralSupplement = Object.freeze({
    schema,
    provenance: Object.freeze({ policyId, policyVersion }),
    facts,
  });
  return Object.freeze({ kind: 'resolved', supplement });
};

const createDefinition = (
  family: AdaptivePlaywrightReferencePolicyFamily,
  policyVersion: AdaptivePlaywrightReferencePolicyVersion,
  schema: string,
  factKind: string,
  attributes: readonly string[],
  limits: GridLimits,
  recordScheduleProjection?: ((reason: ScheduleProjectionDiagnosticReason) => void) | undefined,
): InternalPolicySetDefinition => Object.freeze({
  policyId: family,
  policyVersion,
  supplementContracts: Object.freeze([Object.freeze({
    schema,
    facts: Object.freeze([Object.freeze({ kind: factKind, attributes })]),
  })]),
  evaluate: ({ snapshotTree, nodes }: InternalPolicyEvaluationContext) => {
    const analysis = analysisFor(family, snapshotTree, nodes, limits);
    return analysis?.route === 'geometry' ? CAPTURE_BOXES : PASSTHROUGH;
  },
  project: (context: InternalPolicyProjectionContext) => {
    const baseline = analysisFor(
      family,
      context.baselineSnapshotTree,
      context.baselineNodes,
      limits,
    );
    const enriched = analysisFor(
      family,
      context.enrichedSnapshotTree,
      context.enrichedNodes,
      limits,
    );
    if (family === 'schedule-coordinate') {
      if (baseline?.family !== 'schedule-coordinate' || baseline.route !== 'geometry') {
        recordScheduleProjection?.('baseline-context');
        return UNRESOLVED;
      }
      if (enriched?.family !== 'schedule-coordinate' || enriched.route !== 'geometry') {
        recordScheduleProjection?.('enriched-context');
        return UNRESOLVED;
      }
      const outcome = scheduleFacts(enriched);
      recordScheduleProjection?.(outcome.reason);
      return outcome.facts === undefined
        ? UNRESOLVED
        : resolvedProjection(family, policyVersion, schema, outcome.facts);
    }
    if (baseline?.route !== 'geometry' || enriched?.route !== 'geometry') return UNRESOLVED;
    const facts = factsFor(enriched, context.enrichedNodes);
    return facts === undefined
      ? UNRESOLVED
      : resolvedProjection(family, policyVersion, schema, facts);
  },
});

const exactGridOptions = (
  options: GridCoordinateReferencePolicyOptions | undefined,
): GridLimits => {
  if (options === undefined) {
    return Object.freeze(Object.assign(Object.create(null) as GridLimits, {
      maxRows: 12,
      maxColumns: 12,
    }));
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Grid-coordinate policy options must be a plain object.');
  }
  if (nodeUtilTypes.isProxy(options)) {
    throw new TypeError('Grid-coordinate policy options cannot be a Proxy.');
  }
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Grid-coordinate policy options must be a plain object.');
  }
  const keys = Reflect.ownKeys(options);
  if (
    keys.some((key) => typeof key !== 'string' ||
      (key !== 'maxRows' && key !== 'maxColumns'))
  ) throw new TypeError('Grid-coordinate policy options have unexpected properties.');
  const values = Object.assign(Object.create(null) as { maxRows: number; maxColumns: number }, {
    maxRows: 12,
    maxColumns: 12,
  });
  for (const key of keys as Array<'maxRows' | 'maxColumns'>) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw new TypeError('Grid-coordinate policy options must use enumerable own data properties.');
    }
    if (
      typeof descriptor.value !== 'number' ||
      !Number.isInteger(descriptor.value) ||
      descriptor.value < 2 || descriptor.value > 32
    ) throw new TypeError('Grid-coordinate policy limits must be integers from 2 through 32.');
    values[key] = descriptor.value;
  }
  if (values.maxRows * values.maxColumns > 256) {
    throw new TypeError('Grid-coordinate policy permits at most 256 projected facts.');
  }
  return Object.freeze(values);
};

const frozenMetadata = <
  Family extends AdaptivePlaywrightReferencePolicyFamily,
  Version extends AdaptivePlaywrightReferencePolicyVersion,
  Support extends AdaptivePlaywrightReferencePolicySupport,
>(family: Family, version: Version, support: Support) => Object.freeze({
  family,
  version,
  support,
});

/** Complete, bounded grid row/column bindings. Explicit opt-in only. */
export function createGridCoordinateReferencePolicy(
  options?: GridCoordinateReferencePolicyOptions,
): GridCoordinateReferencePolicy {
  const limits = exactGridOptions(options);
  const attributes = Object.freeze(['row', 'column'] as const);
  const support: GridCoordinateReferencePolicySupport = Object.freeze({
    feature: 'geometry',
    schema: 'grid-coordinate/1',
    factKind: 'grid-cell',
    attributes,
    completeOrNone: true,
    refSource: 'current-boxed-snapshot',
    minimumFacts: 4,
    maximumFacts: limits.maxRows * limits.maxColumns,
    limits: Object.freeze({
      minimumRows: 2,
      maximumRows: limits.maxRows,
      minimumColumns: 2,
      maximumColumns: limits.maxColumns,
    }),
  });
  return createInternalPolicySetWithMetadata(
    createDefinition(
      'grid-coordinate',
      'grid-coordinate-policy/1',
      support.schema,
      support.factKind,
      attributes,
      limits,
    ),
    frozenMetadata('grid-coordinate', 'grid-coordinate-policy/1', support),
  );
}

/** Complete, bounded resource/time schedule bindings. Explicit opt-in only. */
export function createScheduleCoordinateReferencePolicy(): ScheduleCoordinateReferencePolicy {
  const limits = Object.freeze({ maxRows: 12, maxColumns: 12 });
  const attributes = Object.freeze(['resource', 'slot'] as const);
  const support: ScheduleCoordinateReferencePolicySupport = Object.freeze({
    feature: 'geometry',
    schema: 'schedule-coordinate/1',
    factKind: 'schedule-slot',
    attributes,
    completeOrNone: true,
    refSource: 'current-boxed-snapshot',
    minimumFacts: 4,
    maximumFacts: 64,
    limits: Object.freeze({
      minimumResources: 2,
      maximumResources: 12,
      minimumSlots: 2,
      maximumSlots: 12,
    }),
  });
  const diagnostic = createScheduleProjectionDiagnosticChannel();
  const policy = createInternalPolicySetWithMetadata(
    createDefinition(
      'schedule-coordinate',
      'schedule-coordinate-policy/3',
      support.schema,
      support.factKind,
      attributes,
      limits,
      diagnostic.record,
    ),
    frozenMetadata('schedule-coordinate', 'schedule-coordinate-policy/3', support),
  );
  diagnostic.bind(policy);
  return policy;
}

/** Complete two-label cross-subtree bindings. Explicit opt-in only. */
export function createCrossTreeLabelReferencePolicy(): CrossTreeLabelReferencePolicy {
  const limits = Object.freeze({ maxRows: 12, maxColumns: 12 });
  const attributes = Object.freeze(['label'] as const);
  const support: CrossTreeLabelReferencePolicySupport = Object.freeze({
    feature: 'geometry',
    schema: 'cross-tree-label/1',
    factKind: 'cross-tree-label',
    attributes,
    completeOrNone: true,
    refSource: 'current-boxed-snapshot',
    minimumFacts: 2,
    maximumFacts: 2,
    limits: Object.freeze({ labels: 2, controls: 2 }),
  });
  return createInternalPolicySetWithMetadata(
    createDefinition(
      'cross-tree-label',
      'cross-tree-label-policy/1',
      support.schema,
      support.factKind,
      attributes,
      limits,
    ),
    frozenMetadata('cross-tree-label', 'cross-tree-label-policy/1', support),
  );
}
