import { describe, expect, it } from "vitest";
import { buildEmbeddingText, codePointLength, normalizeField, sha256Hex } from "../src/shared/text.ts";
import { cosineSimilarity, parseVectorJson, toUnitFloat64, validateVector } from "../src/shared/vector.ts";

describe("text normalization", () => {
  it("NFC・LF統一・前後空白除去を行い、内部の改行や記号は保持する", () => {
    const decomposed = "ﾃｽﾄ ガ".normalize("NFD"); // 「ガ」を分解形に
    expect(normalizeField(`  ${decomposed}\r\n1行目\r2行目 \t `)).toBe("ﾃｽﾄ ガ\n1行目\n2行目");
    expect(normalizeField("  a  b\n\nc  ")).toBe("a  b\n\nc");
    expect(normalizeField(null)).toBe("");
  });

  it("テンプレート faq-v1 の完成テキストを作る", () => {
    expect(buildEmbeddingText({ category: " アカウント ", question: "Q?\r\n", answer: "\nA 1,000円。" })).toBe(
      "カテゴリ：アカウント\n質問：Q?\n回答：A 1,000円。",
    );
  });

  it("SHA-256 を16進小文字で返す", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex("カテゴリ：")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("コードポイント数を数える（サロゲートペアは1）", () => {
    expect(codePointLength("𠮷野家")).toBe(3);
  });
});

describe("vector validation / similarity", () => {
  it("同一・直交・逆向きのコサイン類似度", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(cosineSimilarity([1, 0], [0, 5])).toBeCloseTo(0, 12);
    expect(cosineSimilarity([1, 1], [-2, -2])).toBeCloseTo(-1, 12);
  });

  it("ゼロ・NaN・Infinity・次元不一致・非配列・JSON破損を検出する", () => {
    expect(validateVector([0, 0, 0], 3)).toEqual({ ok: false, reason: "zero_norm" });
    expect(validateVector([1, Number.NaN, 0], 3)).toEqual({ ok: false, reason: "non_finite" });
    expect(validateVector([1, Number.POSITIVE_INFINITY, 0], 3)).toEqual({ ok: false, reason: "non_finite" });
    expect(validateVector([1, "2", 0], 3)).toEqual({ ok: false, reason: "non_finite" });
    expect(validateVector([1, 2], 3)).toEqual({ ok: false, reason: "dimension_mismatch" });
    expect(validateVector({ 0: 1 }, 1)).toEqual({ ok: false, reason: "not_array" });
    expect(parseVectorJson("[1, 2,", 3)).toEqual({ ok: false, reason: "invalid_json" });
    expect(parseVectorJson("[1, NaN, 2]", 3)).toEqual({ ok: false, reason: "invalid_json" });
    expect(() => cosineSimilarity([0, 0], [1, 0])).toThrow();
    expect(() => cosineSimilarity([1], [1, 0])).toThrow();
  });

  it("正規化後の内積がコサイン類似度に一致する", () => {
    const a = validateVector([3, 4, 0], 3);
    const b = validateVector([4, 3, 1], 3);
    if (!a.ok || !b.ok) throw new Error("unexpected");
    const ua = toUnitFloat64(a.vector, a.norm);
    const ub = toUnitFloat64(b.vector, b.norm);
    const d = ua.reduce((s, v, i) => s + v * ub[i]!, 0);
    expect(d).toBeCloseTo(cosineSimilarity([3, 4, 0], [4, 3, 1]), 12);
  });
});
