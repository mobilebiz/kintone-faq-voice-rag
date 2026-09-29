import { describe, expect, it } from "vitest";
import { DEFAULT_FIELD_CODES } from "../src/shared/fields.ts";
import type { KintoneRecord } from "../src/shared/kintone.ts";
import { rank } from "../src/shared/search.ts";
import { buildSnapshot, type FaqEntry } from "../src/shared/snapshot.ts";
import { buildEmbeddingText, sha256Hex } from "../src/shared/text.ts";

function entry(id: number, category: string, vec: number[]): FaqEntry {
  const n = Math.hypot(...vec);
  return { id: String(id), idNum: id, category, question: `q${id}`, answer: `a${id}`, vector: Float32Array.from(vec.map((v) => v / n)) };
}

const base = { limit: 3, minSimilarity: 0.5, ambiguityMargin: 0.05 };

describe("rank", () => {
  const entries = [
    entry(10, "A", [1, 0, 0]),
    entry(2, "A", [0.9, 0.1, 0]),
    entry(3, "B", [0, 1, 0]),
    entry(4, "B", [0.6, 0.8, 0]),
  ];

  it("類似度降順・limit件で返し、1位と2位に差があれば matched", () => {
    const out = rank(entries, { ...base, queryUnit: [1, 0, 0], ambiguityMargin: 0.001, limit: 2 });
    expect(out.status).toBe("matched");
    expect(out.results.map((r) => r.entry.id)).toEqual(["10", "2"]);
  });

  it("同点は数値としてのレコードID昇順（文字列順ではない）", () => {
    const tie = [entry(10, "A", [1, 0]), entry(9, "A", [1, 0]), entry(100, "A", [1, 0])];
    const out = rank(tie, { ...base, queryUnit: [1, 0], ambiguityMargin: 0 });
    expect(out.results.map((r) => r.entry.id)).toEqual(["9", "10", "100"]);
  });

  it("カテゴリ完全一致で絞り込む", () => {
    const out = rank(entries, { ...base, queryUnit: [1, 0, 0], category: "B", ambiguityMargin: 0 });
    expect(out.results.map((r) => r.entry.category)).toEqual(["B"]);
    expect(out.results[0]!.entry.id).toBe("4");
  });

  it("該当カテゴリがなければ no_match / empty_category", () => {
    const out = rank(entries, { ...base, queryUnit: [1, 0, 0], category: "Ａ" });
    expect(out).toMatchObject({ status: "no_match", reason: "empty_category", results: [] });
  });

  it("しきい値未満だけなら no_match / below_threshold", () => {
    const out = rank(entries, { ...base, queryUnit: [0, 0, 1] });
    expect(out).toMatchObject({ status: "no_match", reason: "below_threshold", results: [] });
    expect(out.allScored).toHaveLength(4);
  });

  it("1位と2位が僅差なら ambiguous。limit=1でも比較用に2件返す", () => {
    const out = rank(entries, { ...base, queryUnit: [1, 0, 0], limit: 1, ambiguityMargin: 0.02 });
    expect(out.status).toBe("ambiguous");
    expect(out.reason).toBe("close_scores");
    expect(out.results).toHaveLength(2);
  });
});

describe("buildSnapshot", () => {
  const f = DEFAULT_FIELD_CODES;
  const spec = "spec-1";
  async function record(id: number, over: Partial<Record<string, string>> = {}, vec: unknown = [1, 0, 0]): Promise<KintoneRecord> {
    const content = { category: "A", question: `質問${id}`, answer: `回答${id}` };
    const r: KintoneRecord = {
      $id: { value: String(id) },
      [f.category]: { value: content.category },
      [f.question]: { value: content.question },
      [f.answer]: { value: content.answer },
      [f.embedding]: { value: typeof vec === "string" ? vec : JSON.stringify(vec) },
      [f.embeddingSpec]: { value: spec },
      [f.embeddingHash]: { value: await sha256Hex(buildEmbeddingText(content)) },
    };
    for (const [k, v] of Object.entries(over)) r[k] = { value: v };
    return r;
  }

  it("仕様ID不一致・ハッシュ不一致・JSON破損・未生成・次元不一致・ゼロを除外して理由別に数える", async () => {
    const recs = [
      await record(1),
      await record(2, { [f.embeddingSpec]: "old-spec" }),
      await record(3, { [f.answer]: "編集後の回答" }),
      await record(4, {}, "[1, 0,"),
      await record(5, {}, ""),
      await record(6, {}, [1, 0]),
      await record(7, {}, [0, 0, 0]),
      await record(8, {}, [1, null, 0]),
    ];
    const snap = await buildSnapshot(recs, { fields: f, specId: spec, dimensions: 3 });
    expect(snap.validCount).toBe(1);
    expect(snap.entries[0]!.id).toBe("1");
    expect(snap.invalidCount).toBe(7);
    expect(snap.invalidReasons).toEqual({
      spec_mismatch: 1,
      hash_mismatch: 1,
      invalid_json: 1,
      missing_embedding: 1,
      dimension_mismatch: 1,
      zero_norm: 1,
      non_finite: 1,
    });
  });
});
