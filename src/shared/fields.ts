/** kintoneフィールドコード。表示名から推定せず、環境変数 FIELD_* で上書きできる（仕様 5章・13章）。 */

export interface FieldCodes {
  category: string;
  question: string;
  answer: string;
  embedding: string;
  embeddingSpec: string;
  embeddingHash: string;
  embeddedAt: string;
}

export const DEFAULT_FIELD_CODES: FieldCodes = {
  category: "category",
  question: "question",
  answer: "answer",
  embedding: "embedding",
  embeddingSpec: "embedding_spec",
  embeddingHash: "embedding_hash",
  embeddedAt: "embedded_at",
};

const ENV_KEYS: Record<keyof FieldCodes, string> = {
  category: "FIELD_CATEGORY",
  question: "FIELD_QUESTION",
  answer: "FIELD_ANSWER",
  embedding: "FIELD_EMBEDDING",
  embeddingSpec: "FIELD_EMBEDDING_SPEC",
  embeddingHash: "FIELD_EMBEDDING_HASH",
  embeddedAt: "FIELD_EMBEDDED_AT",
};

export function fieldCodesFromEnv(env: Record<string, unknown>): FieldCodes {
  const out = { ...DEFAULT_FIELD_CODES };
  for (const key of Object.keys(ENV_KEYS) as (keyof FieldCodes)[]) {
    const v = env[ENV_KEYS[key]];
    if (typeof v === "string" && v.trim() !== "") out[key] = v.trim();
  }
  return out;
}
