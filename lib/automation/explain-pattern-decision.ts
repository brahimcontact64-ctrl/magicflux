/**
 * Explainability layer for pattern scoring decisions.
 *
 * explainPatternDecision() mirrors the scoring logic of scorePattern() +
 * providerContaminationPenalty() in engine.ts but returns a human-readable
 * breakdown for debugging and testing. It has NO effect on runtime behavior.
 *
 * Usage:
 *   const explanation = explainPatternDecision(prompt, inferredCapabilities, patternRow, constraints);
 *   console.log(explanation);
 */

import {
  CANONICAL_PROVIDERS,
  expandProviderAliases,
  normalizeForProviderScan,
} from '@/lib/agent/provider-allowlist';
import type { ConstraintContext, PatternKind } from './types';

export type PenaltySource = 'name' | 'description' | 'examples' | 'intent_keywords';

export type PenaltyDetail = {
  provider: string;
  alias: string;
  source: PenaltySource;
};

export type PatternDecisionExplanation = {
  pattern: string;
  keywordScore: number;
  capabilityScore: number;
  popularityScore: number;
  baseScore: number;
  boost: number;
  providerPenalty: number;
  finalScore: number;
  penaltyDetails: PenaltyDetail[];
  reasons: string[];
  rejected: boolean;
  rejectionReason?: string;
};

type ExplainablePattern = {
  name: string;
  description?: string | null;
  examples?: string[] | null;
  intent_keywords?: string[] | null;
  required_capabilities?: string[] | null;
  required_tools?: string[] | null;
  optional_tools?: string[] | null;
  schedule_patterns?: string[] | null;
  popularity_score?: number | null;
  kind: PatternKind;
  classification?: { providers?: string[] } | null;
};

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ');
}

export function explainPatternDecision(
  prompt: string,
  inferredCapabilities: string[],
  pattern: ExplainablePattern,
  constraints: ConstraintContext,
  boost = 0
): PatternDecisionExplanation {
  const normalized = normalize(prompt);
  const reasons: string[] = [];
  const penaltyDetails: PenaltyDetail[] = [];

  // ── keyword score (mirrors scorePattern) ────────────────────────────────────
  const keywords = pattern.intent_keywords ?? [];
  let keywordScore = 0;
  for (const keyword of keywords) {
    if (normalized.includes(keyword.toLowerCase())) {
      keywordScore += 8;
      reasons.push(`keyword_match: "${keyword}" (+8)`);
    }
  }

  // ── capability score (mirrors scorePattern) ──────────────────────────────────
  const requiredCaps = pattern.required_capabilities ?? [];
  const capOverlap = requiredCaps.filter((cap) => inferredCapabilities.includes(cap));
  const capabilityScore = capOverlap.length * 10;
  for (const cap of capOverlap) {
    reasons.push(`capability_overlap: "${cap}" (+10)`);
  }

  // ── popularity score (mirrors scorePattern) ──────────────────────────────────
  const popularityScore = Math.min(20, Math.max(0, (pattern.popularity_score ?? 0) / 5));
  if (popularityScore > 0) {
    reasons.push(`popularity_score: ${popularityScore}`);
  }

  const baseScore = keywordScore + capabilityScore + popularityScore;

  // ── boost ────────────────────────────────────────────────────────────────────
  if (boost > 0) {
    reasons.push(`reply_boost: +${boost}`);
  }

  // ── provider contamination penalty (mirrors providerContaminationPenalty) ────
  const SOURCES: Array<{ key: PenaltySource; value: string[] }> = [
    { key: 'name',            value: [pattern.name] },
    { key: 'description',     value: pattern.description ? [pattern.description] : [] },
    { key: 'examples',        value: pattern.examples ?? [] },
    { key: 'intent_keywords', value: pattern.intent_keywords ?? [] },
  ];

  let providerPenalty = 0;

  if (constraints.identityLocked && constraints.allowedProviders.length > 0) {
    for (const provider of CANONICAL_PROVIDERS) {
      if (constraints.allowedProviders.includes(provider)) continue;

      const aliases = expandProviderAliases(provider);
      let firstMatch: PenaltyDetail | null = null;

      outer: for (const src of SOURCES) {
        for (const text of src.value) {
          if (!text) continue;
          const normalized = normalizeForProviderScan(text);
          for (const alias of aliases) {
            const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp(`\\b${escaped}\\b`).test(normalized)) {
              firstMatch = { provider, alias, source: src.key };
              break outer;
            }
          }
        }
      }

      if (firstMatch) {
        penaltyDetails.push(firstMatch);
        providerPenalty += 15;
        reasons.push(
          `forbidden_provider: "${firstMatch.provider}" detected via alias "${firstMatch.alias}" in ${firstMatch.source} (-15)`
        );
      }
    }
  }

  const finalScore = baseScore + boost - providerPenalty;

  const rejected = finalScore <= 0;
  const rejectionReason = rejected
    ? finalScore === 0
      ? 'Score is zero — pattern not eligible.'
      : `Score dropped below zero (${finalScore}) after penalty.`
    : undefined;

  return {
    pattern: pattern.name,
    keywordScore,
    capabilityScore,
    popularityScore,
    baseScore,
    boost,
    providerPenalty,
    finalScore,
    penaltyDetails,
    reasons,
    rejected,
    rejectionReason,
  };
}
