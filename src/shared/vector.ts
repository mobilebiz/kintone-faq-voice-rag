/**
 * ベクトルの検証・正規化・類似度計算（仕様 8章）。
 */

export type VectorInvalidReason =
  | "invalid_json"
  | "not_array"
  | "dimension_mismatch"
  | "non_finite"
  | "zero_norm";

export type VectorCheck =
  | { ok: true; vector: Float64Array; norm: number }
  | { ok: false; reason: VectorInvalidReason };

/** 型・次元・有限値・非ゼロノルムを検証する。 */
export function validateVector(value: unknown, dimensions: number): VectorCheck {
  if (!Array.isArray(value)) return { ok: false, reason: "not_array" };
  if (value.length !== dimensions) return { ok: false, reason: "dimension_mismatch" };
  const vec = new Float64Array(dimensions);
  let sumSq = 0;
  for (let i = 0; i < dimensions; i++) {
    const v = value[i];
    if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, reason: "non_finite" };
    vec[i] = v;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (!(norm > 0) || !Number.isFinite(norm)) return { ok: false, reason: "zero_norm" };
  return { ok: true, vector: vec, norm };
}

/** kintoneに保存したJSON文字列を検証する。 */
export function parseVectorJson(json: string, dimensions: number): VectorCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  return validateVector(parsed, dimensions);
}

/** 単位ベクトル化したFloat32Array（キャッシュ投入用）。 */
export function toUnitFloat32(vector: Float64Array, norm: number): Float32Array {
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i]! / norm;
  return out;
}

export function toUnitFloat64(vector: Float64Array, norm: number): Float64Array {
  const out = new Float64Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i]! / norm;
  return out;
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error("dimension mismatch");
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** dot(q, d) / (norm(q) * norm(d))。ゼロノルムはエラー。 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error("dimension mismatch");
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    d += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!(na > 0) || !(nb > 0)) throw new Error("zero norm");
  return d / (Math.sqrt(na) * Math.sqrt(nb));
}
