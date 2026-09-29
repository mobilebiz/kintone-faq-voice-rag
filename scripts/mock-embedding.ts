/**
 * 開発・テスト用の決定的な擬似Embedding（文字uni-gram/bi-gramのハッシュ）。
 * 意味検索の品質評価には使えない。API契約・処理経路の検証専用。
 */
import { normalizeField } from "../src/shared/text.ts";

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** テンプレートの見出し（カテゴリ：質問：回答：）は全FAQ共通のため除いて特徴化する。 */
export function mockEmbedding(text: string, dimensions: number): number[] {
  const cleaned = normalizeField(text)
    .replace(/^(カテゴリ|質問|回答)：/gm, "")
    .replace(/[\s、。？！「」（）・,.?!()]/g, "");
  const vec: number[] = new Array<number>(dimensions).fill(0);
  const chars = Array.from(cleaned);
  const add = (gram: string, w: number) => {
    const h = fnv1a(gram);
    vec[h % dimensions]! += (h & 0x80000000 ? -1 : 1) * w;
  };
  for (let i = 0; i < chars.length; i++) {
    add(chars[i]!, 0.5);
    if (i + 1 < chars.length) add(chars[i]! + chars[i + 1]!, 1);
  }
  if (!vec.some((v) => v !== 0)) vec[0] = 1;
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => Number((v / norm).toFixed(6)));
}
