/**
 * 検索アルゴリズム（仕様 8章）。純粋関数。
 */
import type { FaqEntry } from "./snapshot.ts";
import { dot } from "./vector.ts";

export type SearchStatus = "matched" | "ambiguous" | "no_match";
export type SearchReason = "below_threshold" | "empty_category" | "close_scores" | null;

export interface RankParams {
  /** 単位ベクトル化済みの検索文ベクトル */
  queryUnit: ArrayLike<number>;
  category?: string;
  limit: number;
  minSimilarity: number;
  ambiguityMargin: number;
}

export interface ScoredEntry {
  entry: FaqEntry;
  score: number;
}

export interface RankOutcome {
  status: SearchStatus;
  reason: SearchReason;
  results: ScoredEntry[];
  /** しきい値調整用：しきい値適用前の全スコア（上位順） */
  allScored: ScoredEntry[];
}

/** 類似度降順、同点は数値としてのレコードID昇順。 */
export function compareScored(a: ScoredEntry, b: ScoredEntry): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.entry.idNum - b.entry.idNum;
}

export function rank(entries: FaqEntry[], p: RankParams): RankOutcome {
  const candidates = p.category !== undefined ? entries.filter((e) => e.category === p.category) : entries;
  if (p.category !== undefined && candidates.length === 0) {
    return { status: "no_match", reason: "empty_category", results: [], allScored: [] };
  }

  const scored: ScoredEntry[] = candidates.map((entry) => ({ entry, score: dot(p.queryUnit, entry.vector) }));
  scored.sort(compareScored);

  const accepted = scored.filter((s) => s.score >= p.minSimilarity);
  if (accepted.length === 0) {
    return { status: "no_match", reason: "below_threshold", results: [], allScored: scored };
  }

  // 曖昧判定はlimit適用前の採用候補で行い、ambiguous時は比較対象の上位2件以上を必ず返す。
  if (accepted.length >= 2 && accepted[0]!.score - accepted[1]!.score < p.ambiguityMargin) {
    return {
      status: "ambiguous",
      reason: "close_scores",
      results: accepted.slice(0, Math.max(p.limit, 2)),
      allScored: scored,
    };
  }
  return { status: "matched", reason: null, results: accepted.slice(0, p.limit), allScored: scored };
}
