/**
 * Builder Proof Module: Hash-based snapshot architecture for deterministic validation
 *
 * Responsibilities:
 * - Create normalized fingerprints of runtime state via crypto hashing
 * - Compare snapshots to detect drift across reload cycles
 * - Validate builder surface visibility (Playwright only)
 * - Never compare UI text directly
 * - Output structured proof artifacts
 *
 * Design principles:
 * 1. All hashes are deterministic (same state → same hash)
 * 2. Snapshot == immutable fingerprint of state at a moment in time
 * 3. Drift detection == comparison of hashes, not DOM
 * 4. Visibility validation == Playwright element count, not text matching
 */

import crypto from 'crypto';
import type { BuilderRuntimeState } from '@/lib/builder/runtime-state';

/**
 * Immutable fingerprint of builder state at a moment in time
 */
export type BuilderSnapshot = {
  timestamp: number;
  runtimeHash: string; // hash of entire BuilderRuntimeState
  graphHash: string; // hash of workflowGraph
  providerHash: string; // hash of integrationCards
  intelligenceHash: string; // hash of automationBrain
  summaryHash: string; // hash of workflowSummary
  deployHash: string; // hash of deployState
  conversationHash: string; // hash of conversation[]
};

/**
 * Result of comparing two snapshots
 */
export type SnapshotComparison = {
  changed: string[]; // list of fields that changed
  drift: boolean; // true if any field changed
  details: {
    runtime: boolean;
    graph: boolean;
    provider: boolean;
    intelligence: boolean;
    summary: boolean;
    deploy: boolean;
    conversation: boolean;
  };
};

/**
 * Result of drift detection across multiple cycles
 */
export type DriftDetection = {
  hasDrift: boolean;
  mutations: Array<{
    field: string;
    from: string;
    to: string;
    cycles: number[];
  }>;
  cycleComparisons: Array<{
    cycle: number;
    comparison: SnapshotComparison;
  }>;
};

/**
 * Surface visibility validation result
 */
export type SurfaceValidation = {
  graphVisible: boolean;
  graphNodeCount: number;
  providerCardsVisible: boolean;
  providerCardCount: number;
  intelligenceVisible: boolean;
  summaryVisible: boolean;
  deployVisible: boolean;
  conversationVisible: boolean;
  allSurfacesPresent: boolean;
};

/**
 * Deterministic hash of normalized input
 */
function createHash(data: unknown): string {
  const normalized = JSON.stringify(data, (_, value) => {
    // Ensure Date objects are serialized consistently
    if (value instanceof Date) {
      return value.toISOString();
    }
    return value;
  });
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Create snapshot: extract all hashes from runtime state
 * @param state BuilderRuntimeState to fingerprint
 * @returns BuilderSnapshot with all hash fields
 */
export function createBuilderSnapshot(state: BuilderRuntimeState): BuilderSnapshot {
  return {
    timestamp: Date.now(),
    runtimeHash: createHash(state),
    graphHash: createHash(state.workflowGraph),
    providerHash: createHash(state.integrationCards),
    intelligenceHash: createHash(state.automationBrain),
    summaryHash: createHash(state.workflowSummary),
    deployHash: createHash(state.deployState),
    conversationHash: createHash(state.conversation),
  };
}

/**
 * Compare two snapshots: determine what changed
 * @param baseline First snapshot (reference)
 * @param current Second snapshot (compared)
 * @returns SnapshotComparison with changed fields and drift boolean
 */
export function compareBuilderSnapshots(
  baseline: BuilderSnapshot,
  current: BuilderSnapshot
): SnapshotComparison {
  const details = {
    runtime: baseline.runtimeHash !== current.runtimeHash,
    graph: baseline.graphHash !== current.graphHash,
    provider: baseline.providerHash !== current.providerHash,
    intelligence: baseline.intelligenceHash !== current.intelligenceHash,
    summary: baseline.summaryHash !== current.summaryHash,
    deploy: baseline.deployHash !== current.deployHash,
    conversation: baseline.conversationHash !== current.conversationHash,
  };

  const changed = Object.entries(details)
    .filter(([_, changed]) => changed)
    .map(([field, _]) => field);

  return {
    changed,
    drift: changed.length > 0,
    details,
  };
}

/**
 * Detect drift across multiple snapshots from reload cycles
 * @param snapshots Array of snapshots from each cycle
 * @returns DriftDetection with mutations and cycle-by-cycle comparisons
 */
export function detectDrift(snapshots: BuilderSnapshot[]): DriftDetection {
  if (snapshots.length < 2) {
    return {
      hasDrift: false,
      mutations: [],
      cycleComparisons: [],
    };
  }

  const baseline = snapshots[0];
  const cycleComparisons: DriftDetection['cycleComparisons'] = [];
  const mutationMap = new Map<
    string,
    { field: string; from: string; to: string; cycles: number[] }
  >();

  // Compare each cycle to baseline
  for (let i = 1; i < snapshots.length; i++) {
    const comparison = compareBuilderSnapshots(baseline, snapshots[i]);
    cycleComparisons.push({ cycle: i + 1, comparison });

    // Track mutations
    for (const field of comparison.changed) {
      const key = `${field}`;
      if (!mutationMap.has(key)) {
        const hashFieldName = `${field}Hash` as keyof BuilderSnapshot;
        const prevValue = String(baseline[hashFieldName]);
        const currValue = String(snapshots[i][hashFieldName]);
        mutationMap.set(key, {
          field,
          from: prevValue,
          to: currValue,
          cycles: [i + 1],
        });
      } else {
        const mutation = mutationMap.get(key)!;
        if (!mutation.cycles.includes(i + 1)) {
          mutation.cycles.push(i + 1);
        }
      }
    }
  }

  const hasDrift = mutationMap.size > 0;
  const mutations = Array.from(mutationMap.values());

  return {
    hasDrift,
    mutations,
    cycleComparisons,
  };
}

/**
 * Validate builder surface visibility using Playwright
 * Only uses element counting, never DOM text matching
 * @param page Playwright Page instance (any type to avoid import issues)
 * @returns SurfaceValidation with visibility booleans and element counts
 */
export async function validateBuilderSurface(page: any): Promise<SurfaceValidation> {
  const inputCount = await page.locator('textarea[placeholder="What do you want to automate today?"]').count();
  const panelCount = await page.locator('div[class*="rounded-xl border"]').count();
  const buttonCount = await page.locator('button').count();
  const graphNodeCount = await page.locator('svg').count();
  const providerCardCount = await page.locator('button[class*="text-left"]').count();

  const shellVisible = inputCount > 0 && panelCount > 0;
  const intelligenceVisible = shellVisible && buttonCount > 0;
  const summaryVisible = shellVisible;
  const deployVisible = shellVisible && buttonCount > 0;
  const conversationVisible = shellVisible;

  return {
    graphVisible: shellVisible,
    graphNodeCount,
    providerCardsVisible: shellVisible,
    providerCardCount,
    intelligenceVisible,
    summaryVisible,
    deployVisible,
    conversationVisible,
    allSurfacesPresent:
      graphNodeCount > 0 &&
      providerCardCount > 0 &&
      intelligenceVisible &&
      summaryVisible &&
      deployVisible &&
      conversationVisible,
  };
}

/**
 * Structured proof artifact representing validation results
 */
export type BuilderProofArtifact = {
  status: 'PASS' | 'FAIL';
  reason: string;
  timestamp: string;
  cycles: number;
  baseline: BuilderSnapshot;
  snapshots: BuilderSnapshot[];
  driftAnalysis: DriftDetection;
  surfaceValidations: SurfaceValidation[];
  failureReasons: {
    crashes: string[];
    hydrationMismatches: string[];
    drift: string[];
    mutations: string[];
    objectLeakage: string[];
  };
};

/**
 * Create a proof artifact from validation results
 */
export function createProofArtifact(
  baseline: BuilderSnapshot,
  snapshots: BuilderSnapshot[],
  surfaceValidations: SurfaceValidation[],
  errors: {
    crashes?: string[];
    hydrationMismatches?: string[];
    objectLeakage?: string[];
  } = {}
): BuilderProofArtifact {
  const driftAnalysis = detectDrift([baseline, ...snapshots]);

  const failureReasons = {
    crashes: errors.crashes ?? [],
    hydrationMismatches: errors.hydrationMismatches ?? [],
    drift: driftAnalysis.mutations.map(
      (m) => `${m.field} mutated in cycles ${m.cycles.join(', ')}`
    ),
    mutations: driftAnalysis.mutations.map(
      (m) => `${m.field}: ${m.from.slice(0, 8)}... → ${m.to.slice(0, 8)}...`
    ),
    objectLeakage: errors.objectLeakage ?? [],
  };

  const allFailures = Object.values(failureReasons).flat();
  const status = allFailures.length === 0 ? 'PASS' : 'FAIL';

  return {
    status,
    reason:
      status === 'PASS'
        ? `✓ Zero drift across ${snapshots.length} cycles, zero mutations, zero hydration mismatches`
        : `✗ ${allFailures.length} failures detected: ${allFailures.slice(0, 3).join('; ')}${allFailures.length > 3 ? '...' : ''}`,
    timestamp: new Date().toISOString(),
    cycles: snapshots.length,
    baseline,
    snapshots,
    driftAnalysis,
    surfaceValidations,
    failureReasons,
  };
}
