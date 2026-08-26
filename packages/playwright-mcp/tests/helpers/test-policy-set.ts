import {
  createInternalPolicySet,
  type AdaptivePlaywrightPolicySet,
  type InternalPolicyDecision,
  type InternalPolicyEvaluationContext,
  type InternalPolicyProjection,
  type InternalPolicyProjectionContext,
} from '../../src/internal/policy-set.js';
import type {
  StructuralFact,
  SupplementContract,
  SupplementProvenance,
} from '../../src/internal/snapshot.js';

interface LenientResolvedProjection {
  readonly kind: 'resolved';
  readonly supplement: Readonly<{
    schema: string;
    facts: readonly StructuralFact[];
    provenance?: SupplementProvenance | undefined;
  }> & Readonly<Record<string, unknown>>;
}

interface TestPolicySetDefinition {
  readonly policyId?: string | undefined;
  readonly policyVersion?: string | undefined;
  readonly supplementContracts?: readonly SupplementContract[] | undefined;
  readonly evaluate: (context: InternalPolicyEvaluationContext) => InternalPolicyDecision;
  readonly project: (
    context: InternalPolicyProjectionContext,
  ) => Exclude<InternalPolicyProjection, { kind: 'resolved' }> | LenientResolvedProjection;
}

const defaultContracts: readonly SupplementContract[] = Object.freeze([
  Object.freeze({
    schema: 'test-projection/1',
    facts: Object.freeze([
      Object.freeze({ kind: 'coordinate', attributes: Object.freeze(['detail', 'lane']) }),
    ]),
  }),
  Object.freeze({
    schema: 'leak-test/1',
    facts: Object.freeze([
      Object.freeze({ kind: 'coordinate', attributes: Object.freeze(['detail']) }),
    ]),
  }),
]);

/** Test-only arbitrary policy seam; it is never emitted in the package build. */
export const createTestPolicySet = (
  definition: TestPolicySetDefinition,
): AdaptivePlaywrightPolicySet => {
  const policyId = definition.policyId ?? 'test-policy';
  const policyVersion = definition.policyVersion ?? 'test-policy/1';
  return createInternalPolicySet({
    policyId,
    policyVersion,
    supplementContracts: definition.supplementContracts ?? defaultContracts,
    evaluate: definition.evaluate,
    project(context) {
      const projection: unknown = definition.project(context);
      if (
        projection === null || typeof projection !== 'object' ||
        (projection as { kind?: unknown }).kind !== 'resolved'
      ) return projection as InternalPolicyProjection;
      const resolved = projection as LenientResolvedProjection;
      return {
        ...resolved,
        supplement: {
          ...resolved.supplement,
          provenance: resolved.supplement.provenance ?? { policyId, policyVersion },
        },
      } as InternalPolicyProjection;
    },
  });
};
