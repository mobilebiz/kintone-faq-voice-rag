/**
 * kintoneレコードから検証済みFAQスナップショットを構築する（仕様 8章 2、9.1）。
 * 仕様ID・ハッシュ・次元数・有限値・非ゼロノルムを満たさないレコードは除外し、件数を理由別に数える。
 */
import type { FieldCodes } from "./fields.ts";
import { fieldString, type KintoneRecord } from "./kintone.ts";
import { buildEmbeddingText, normalizeField, sha256Hex } from "./text.ts";
import { parseVectorJson, toUnitFloat32, type VectorInvalidReason } from "./vector.ts";

export interface FaqEntry {
  id: string;
  idNum: number;
  category: string;
  question: string;
  answer: string;
  /** 単位ベクトル */
  vector: Float32Array;
}

export type RecordInvalidReason =
  | "missing_embedding"
  | "spec_mismatch"
  | "hash_mismatch"
  | VectorInvalidReason;

export interface SnapshotData {
  entries: FaqEntry[];
  fetchedCount: number;
  validCount: number;
  invalidCount: number;
  invalidReasons: Partial<Record<RecordInvalidReason, number>>;
}

export interface SnapshotOptions {
  fields: FieldCodes;
  specId: string;
  dimensions: number;
}

export async function buildSnapshot(records: KintoneRecord[], opts: SnapshotOptions): Promise<SnapshotData> {
  const entries: FaqEntry[] = [];
  const invalidReasons: Partial<Record<RecordInvalidReason, number>> = {};
  const bump = (r: RecordInvalidReason) => {
    invalidReasons[r] = (invalidReasons[r] ?? 0) + 1;
  };

  for (const rec of records) {
    const id = fieldString(rec, "$id");
    const idNum = Number(id);
    const category = normalizeField(fieldString(rec, opts.fields.category));
    const question = normalizeField(fieldString(rec, opts.fields.question));
    const answer = normalizeField(fieldString(rec, opts.fields.answer));
    const embeddingJson = fieldString(rec, opts.fields.embedding).trim();

    if (embeddingJson === "") {
      bump("missing_embedding");
      continue;
    }
    if (fieldString(rec, opts.fields.embeddingSpec).trim() !== opts.specId) {
      bump("spec_mismatch");
      continue;
    }
    const expectedHash = await sha256Hex(buildEmbeddingText({ category, question, answer }));
    if (fieldString(rec, opts.fields.embeddingHash).trim().toLowerCase() !== expectedHash) {
      bump("hash_mismatch");
      continue;
    }
    const check = parseVectorJson(embeddingJson, opts.dimensions);
    if (!check.ok) {
      bump(check.reason);
      continue;
    }
    entries.push({ id, idNum, category, question, answer, vector: toUnitFloat32(check.vector, check.norm) });
  }

  const invalidCount = records.length - entries.length;
  return {
    entries,
    fetchedCount: records.length,
    validCount: entries.length,
    invalidCount,
    invalidReasons,
  };
}
