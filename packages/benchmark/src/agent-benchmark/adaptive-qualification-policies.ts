import {
  PLAYWRIGHT_GEOMETRY_FEATURE,
  type AdaptiveSnapshotDecision,
  type AdaptiveSnapshotPolicy,
  type AdaptiveSnapshotPolicyContext,
  type AdaptiveSnapshotProjection,
  type AdaptiveSnapshotProjectionContext,
} from './adaptive-snapshot-policy.js';
import {
  isPlaywrightSnapshotDescendant,
  parsePlaywrightSnapshotNodes,
  type PlaywrightSnapshotBox,
  type PlaywrightSnapshotNode,
} from './playwright-snapshot-document.js';

export const ADAPTIVE_QUALIFICATION_POLICIES_VERSION =
  'adaptive-qualification-policies/1' as const;

const normalized = (value: string): string =>
  value.normalize('NFKC').replace(/\s+/gu, ' ').trim();

const normalizedKey = (value: string): string =>
  normalized(value).toLocaleLowerCase('en-US');

const labelOccurs = (name: string, label: string): boolean => {
  const haystack = ` ${normalizedKey(name)} `;
  const needle = ` ${normalizedKey(label)} `;
  return haystack.includes(needle);
};

const exactUniqueNamed = (
  nodes: readonly PlaywrightSnapshotNode[],
): Array<PlaywrightSnapshotNode & { name: string }> | undefined => {
  const retained: Array<PlaywrightSnapshotNode & { name: string }> = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.name === undefined || normalized(node.name).length === 0) return undefined;
    const key = normalizedKey(node.name);
    if (seen.has(key)) return undefined;
    seen.add(key);
    retained.push(node as PlaywrightSnapshotNode & { name: string });
  }
  return retained;
};

const directChildren = (
  nodes: readonly PlaywrightSnapshotNode[],
  parentIndex: number,
): readonly PlaywrightSnapshotNode[] =>
  nodes.filter((node) => node.parentIndex === parentIndex);

const descendants = (
  nodes: readonly PlaywrightSnapshotNode[],
  ancestorIndex: number,
): readonly PlaywrightSnapshotNode[] =>
  nodes.filter((node) => isPlaywrightSnapshotDescendant(nodes, node.index, ancestorIndex));

const groupsByName = <Node extends PlaywrightSnapshotNode & { name: string }>(
  nodes: readonly Node[],
): readonly (readonly Node[])[] => {
  const groups = new Map<string, Node[]>();
  for (const node of nodes) {
    const key = normalizedKey(node.name);
    const group = groups.get(key) ?? [];
    group.push(node);
    groups.set(key, group);
  }
  return [...groups.values()];
};

const completeSemanticBindings = (
  candidates: readonly (PlaywrightSnapshotNode & { name: string; ref: string })[],
  first: readonly (PlaywrightSnapshotNode & { name: string })[],
  second: readonly (PlaywrightSnapshotNode & { name: string })[],
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

const centerWithin = (
  candidate: PlaywrightSnapshotBox,
  band: PlaywrightSnapshotBox,
  axis: 'x' | 'y',
): boolean => {
  const size = axis === 'x' ? 'width' : 'height';
  const center = candidate[axis] + candidate[size] / 2;
  return center >= band[axis] && center < band[axis] + band[size];
};

const boxInside = (inner: PlaywrightSnapshotBox, outer: PlaywrightSnapshotBox): boolean =>
  inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

const bandsDoNotOverlap = (
  boxes: readonly PlaywrightSnapshotBox[],
  axis: 'x' | 'y',
): boolean => {
  const size = axis === 'x' ? 'width' : 'height';
  const ordered = [...boxes].sort((left, right) => left[axis] - right[axis]);
  return ordered.every((box, index) => index === 0 ||
    ordered[index - 1]![axis] + ordered[index - 1]![size] <= box[axis]);
};

const withBox = <Node extends PlaywrightSnapshotNode>(
  node: Node,
): node is Node & { box: PlaywrightSnapshotBox } => node.box !== undefined;

interface ScheduleAnalysis {
  route: 'sufficient' | 'geometry';
  root: PlaywrightSnapshotNode;
  resources: readonly (PlaywrightSnapshotNode & { name: string })[];
  slots: readonly (PlaywrightSnapshotNode & { name: string })[];
  candidates: readonly (PlaywrightSnapshotNode & { name: string; ref: string })[];
}

const timeLike = /(?:^|\s)(?:[01]\d|2[0-3]):[0-5]\d(?:\s|$)/u;

const analyzeSchedule = (snapshotTree: string): ScheduleAnalysis | undefined => {
  const nodes = parsePlaywrightSnapshotNodes(snapshotTree);
  const roots = nodes.filter(({ role }) => role === 'table' || role === 'grid');
  const buttons = nodes.filter(
    (node): node is PlaywrightSnapshotNode & { name: string; ref: string } =>
      node.role === 'button' && node.name !== undefined && node.ref !== undefined,
  );
  const matches: ScheduleAnalysis[] = [];
  for (const root of roots) {
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
    const outsideButtons = buttons.filter((button) =>
      !isPlaywrightSnapshotDescendant(nodes, button.index, root.index));
    const expectedCount = resources.length * slots.length;
    const semantic = outsideButtons.filter(({ name }) => {
      const resourceMatches = resources.filter((resource) => labelOccurs(name, resource.name));
      const slotMatches = slots.filter((slot) => labelOccurs(name, slot.name));
      return resourceMatches.length === 1 && slotMatches.length === 1;
    });
    const semanticComplete = completeSemanticBindings(semantic, resources, slots);
    const ambiguous = groupsByName(outsideButtons).filter((group) =>
      group.length === expectedCount &&
      new Set(group.map(({ ref: candidateRef }) => candidateRef)).size === expectedCount);
    if (semanticComplete && ambiguous.length === 0) {
      matches.push({ route: 'sufficient', root, resources, slots, candidates: semantic });
    } else if (!semanticComplete && ambiguous.length === 1) {
      matches.push({
        route: 'geometry',
        root,
        resources,
        slots,
        candidates: ambiguous[0]!,
      });
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
};

const scheduleFacts = (analysis: ScheduleAnalysis) => {
  if (analysis.root.box === undefined) return undefined;
  const resources = analysis.resources.filter(withBox);
  const slots = analysis.slots.filter(withBox);
  const candidates = analysis.candidates.filter(withBox);
  if (
    resources.length !== analysis.resources.length ||
    slots.length !== analysis.slots.length ||
    candidates.length !== analysis.candidates.length ||
    !bandsDoNotOverlap(resources.map(({ box }) => box), 'y') ||
    !bandsDoNotOverlap(slots.map(({ box }) => box), 'x') ||
    ![...resources, ...slots, ...candidates].every(({ box }) =>
      boxInside(box, analysis.root.box!))
  ) return undefined;
  const facts = candidates.flatMap((candidate) => {
    const matchingResources = resources.filter((resource) =>
      centerWithin(candidate.box, resource.box, 'y'));
    const matchingSlots = slots.filter((slot) => centerWithin(candidate.box, slot.box, 'x'));
    return matchingResources.length === 1 && matchingSlots.length === 1
      ? [{
          ref: candidate.ref,
          resource: matchingResources[0]!.name,
          slot: matchingSlots[0]!.name,
        }]
      : [];
  });
  const expectedCount = resources.length * slots.length;
  const coordinateKeys = facts.map(({ resource, slot }) => `${resource}\u0000${slot}`);
  if (
    facts.length !== expectedCount ||
    new Set(facts.map(({ ref: candidateRef }) => candidateRef)).size !== expectedCount ||
    new Set(coordinateKeys).size !== expectedCount
  ) return undefined;
  return facts;
};

/** Query-independent schedule detector and complete coordinate projector. */
export function createScheduleCoordinateSnapshotPolicy(): AdaptiveSnapshotPolicy {
  return Object.freeze({
    id: 'schedule-coordinate',
    version: 'schedule-coordinate-policy/1',
    reasonCodes: Object.freeze([
      'no-unique-schedule-coordinate-context',
      'complete-schedule-binding-proven',
      'complete-schedule-binding-needs-geometry',
      'complete-schedule-binding-unresolved',
      'complete-schedule-binding-projected',
    ]),
    evaluate(context: AdaptiveSnapshotPolicyContext): AdaptiveSnapshotDecision {
      const analysis = analyzeSchedule(context.snapshotTree);
      if (analysis === undefined) {
        return { kind: 'not-applicable', code: 'no-unique-schedule-coordinate-context' };
      }
      return analysis.route === 'sufficient'
        ? { kind: 'sufficient', code: 'complete-schedule-binding-proven' }
        : {
            kind: 'require',
            code: 'complete-schedule-binding-needs-geometry',
            feature: PLAYWRIGHT_GEOMETRY_FEATURE,
          };
    },
    project(context: AdaptiveSnapshotProjectionContext): AdaptiveSnapshotProjection {
      const analysis = analyzeSchedule(context.featureSnapshotTree);
      const facts = analysis === undefined ? undefined : scheduleFacts(analysis);
      if (facts === undefined) {
        return { kind: 'unresolved', code: 'complete-schedule-binding-unresolved' };
      }
      return {
        kind: 'resolved',
        code: 'complete-schedule-binding-projected',
        supplement: {
          schema: 'schedule-coordinate/1',
          facts: facts.map((fact) => ({
            kind: 'schedule-slot',
            ref: fact.ref,
            attributes: { resource: fact.resource, slot: fact.slot },
          })),
        },
      };
    },
  });
}

interface CrossTreeAnalysis {
  route: 'sufficient' | 'geometry';
  root: PlaywrightSnapshotNode;
  labelContainer: PlaywrightSnapshotNode;
  controlContainer: PlaywrightSnapshotNode;
  labels: readonly (PlaywrightSnapshotNode & { name: string })[];
  candidates: readonly (PlaywrightSnapshotNode & { name: string; ref: string })[];
}

const analyzeCrossTree = (snapshotTree: string): CrossTreeAnalysis | undefined => {
  const nodes = parsePlaywrightSnapshotNodes(snapshotTree);
  const roots = nodes.filter(({ role }) => role === 'region' || role === 'form');
  const matches: CrossTreeAnalysis[] = [];
  for (const root of roots) {
    const containers = directChildren(nodes, root.index)
      .filter(({ role }) => role === 'group' || role === 'list');
    const containerAnalyses = containers.map((container) => {
      const inside = descendants(nodes, container.index);
      const labels = exactUniqueNamed(inside.filter(({ role }) =>
        role === 'heading' || role === 'term'));
      const candidates = inside.filter(
        (node): node is PlaywrightSnapshotNode & { name: string; ref: string } =>
          node.role === 'button' && node.name !== undefined && node.ref !== undefined,
      );
      return { container, labels, candidates };
    });
    const labelContainers = containerAnalyses.filter(({ labels, candidates }) =>
      labels?.length === 2 && candidates.length === 0);
    const controlContainers = containerAnalyses.filter(({ labels, candidates }) =>
      (labels?.length ?? 0) === 0 && candidates.length === 2);
    if (labelContainers.length !== 1 || controlContainers.length !== 1) continue;
    const labelContext = labelContainers[0]!;
    const controlContext = controlContainers[0]!;
    const labels = labelContext.labels!;
    const candidates = controlContext.candidates;
    const semanticCandidates = candidates.filter(({ name }) =>
      labels.filter((label) => labelOccurs(name, label.name)).length === 1);
    const semanticComplete = semanticCandidates.length === labels.length &&
      labels.every((label) => semanticCandidates.filter(({ name }) =>
        labelOccurs(name, label.name)).length === 1);
    const ambiguous = groupsByName(candidates).filter((group) =>
      group.length === labels.length &&
      new Set(group.map(({ ref: candidateRef }) => candidateRef)).size === labels.length);
    if (semanticComplete && ambiguous.length === 0) {
      matches.push({
        route: 'sufficient',
        root,
        labelContainer: labelContext.container,
        controlContainer: controlContext.container,
        labels,
        candidates: semanticCandidates,
      });
    } else if (!semanticComplete && ambiguous.length === 1) {
      matches.push({
        route: 'geometry',
        root,
        labelContainer: labelContext.container,
        controlContainer: controlContext.container,
        labels,
        candidates: ambiguous[0]!,
      });
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
};

const crossTreeFacts = (analysis: CrossTreeAnalysis) => {
  if (
    analysis.root.box === undefined ||
    analysis.labelContainer.box === undefined ||
    analysis.controlContainer.box === undefined
  ) return undefined;
  const labels = analysis.labels.filter(withBox);
  const candidates = analysis.candidates.filter(withBox);
  if (
    labels.length !== analysis.labels.length ||
    candidates.length !== analysis.candidates.length ||
    !bandsDoNotOverlap(labels.map(({ box }) => box), 'y') ||
    !bandsDoNotOverlap(candidates.map(({ box }) => box), 'y') ||
    !labels.every(({ box }) => boxInside(box, analysis.labelContainer.box!)) ||
    !candidates.every(({ box }) => boxInside(box, analysis.controlContainer.box!)) ||
    !boxInside(analysis.labelContainer.box, analysis.root.box) ||
    !boxInside(analysis.controlContainer.box, analysis.root.box)
  ) return undefined;
  const facts = candidates.flatMap((candidate) => {
    const matching = labels.filter((label) => centerWithin(candidate.box, label.box, 'y'));
    return matching.length === 1
      ? [{ ref: candidate.ref, label: matching[0]!.name }]
      : [];
  });
  if (
    facts.length !== labels.length ||
    new Set(facts.map(({ ref: candidateRef }) => candidateRef)).size !== labels.length ||
    new Set(facts.map(({ label }) => label)).size !== labels.length
  ) return undefined;
  return facts;
};

/** Query-independent cross-subtree label detector and complete relation projector. */
export function createCrossTreeLabelSnapshotPolicy(): AdaptiveSnapshotPolicy {
  return Object.freeze({
    id: 'cross-tree-label',
    version: 'cross-tree-label-policy/1',
    reasonCodes: Object.freeze([
      'no-unique-cross-tree-label-context',
      'complete-cross-tree-binding-proven',
      'complete-cross-tree-binding-needs-geometry',
      'complete-cross-tree-binding-unresolved',
      'complete-cross-tree-binding-projected',
    ]),
    evaluate(context: AdaptiveSnapshotPolicyContext): AdaptiveSnapshotDecision {
      const analysis = analyzeCrossTree(context.snapshotTree);
      if (analysis === undefined) {
        return { kind: 'not-applicable', code: 'no-unique-cross-tree-label-context' };
      }
      return analysis.route === 'sufficient'
        ? { kind: 'sufficient', code: 'complete-cross-tree-binding-proven' }
        : {
            kind: 'require',
            code: 'complete-cross-tree-binding-needs-geometry',
            feature: PLAYWRIGHT_GEOMETRY_FEATURE,
          };
    },
    project(context: AdaptiveSnapshotProjectionContext): AdaptiveSnapshotProjection {
      const analysis = analyzeCrossTree(context.featureSnapshotTree);
      const facts = analysis === undefined ? undefined : crossTreeFacts(analysis);
      if (facts === undefined) {
        return { kind: 'unresolved', code: 'complete-cross-tree-binding-unresolved' };
      }
      return {
        kind: 'resolved',
        code: 'complete-cross-tree-binding-projected',
        supplement: {
          schema: 'cross-tree-label/1',
          facts: facts.map((fact) => ({
            kind: 'cross-tree-label',
            ref: fact.ref,
            attributes: { label: fact.label },
          })),
        },
      };
    },
  });
}
