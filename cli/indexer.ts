/**
 * FAQベクトルの差分索引（仕様 6章）。
 * 1. 元レコードと $revision を取得 → 2. 入力文章・ハッシュで差分判定 → 3. Embedding生成・検証
 * → 4. 元 revision を指定してベクトル関連4項目だけ更新 → 5. 競合時は再取得して再評価（最大2回）。
 * FAQ原文・秘密情報はログに出さない。
 */
import { createEmbedding } from "../src/shared/embedding.ts";
import { UpstreamError } from "../src/shared/errors.ts";
import { fetchAllRecords, fieldString, updateRecord, type KintoneRecord } from "../src/shared/kintone.ts";
import { buildEmbeddingText, codePointLength, sha256Hex } from "../src/shared/text.ts";
import { parseVectorJson, validateVector } from "../src/shared/vector.ts";
import type { CliConfig } from "./config.ts";

/** kintone 文字列（複数行）の上限に対する安全側の上限。 */
const MAX_EMBEDDING_JSON_CHARS = 64000;

export type ChangeReason = "force" | "missing" | "spec_changed" | "content_changed" | "invalid_vector";

export interface IndexOptions {
  dryRun?: boolean;
  force?: boolean;
  ids?: string[];
  concurrency?: number;
  maxConflictRetries?: number;
  maxBackoffAttempts?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface IndexReport {
  planned: { id: string; reasons: ChangeReason[] }[];
  updated: string[];
  skipped: string[];
  conflicts: string[];
  failed: { id: string; reason: string }[];
  dryRun: boolean;
}

interface Evaluation {
  error?: string;
  reasons: ChangeReason[];
  text: string;
  hash: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function evaluateRecord(rec: KintoneRecord, cfg: CliConfig, force: boolean): Promise<Evaluation> {
  const f = cfg.fields;
  const content = {
    category: fieldString(rec, f.category),
    question: fieldString(rec, f.question),
    answer: fieldString(rec, f.answer),
  };
  const text = buildEmbeddingText(content);
  const hash = await sha256Hex(text);
  if (content.question.trim() === "" && content.answer.trim() === "") {
    return { error: "empty_content", reasons: [], text, hash };
  }
  if (codePointLength(text) > cfg.maxInputChars) {
    return { error: "input_too_long", reasons: [], text, hash };
  }

  const reasons: ChangeReason[] = [];
  if (force) reasons.push("force");
  const embeddingJson = fieldString(rec, f.embedding).trim();
  if (embeddingJson === "") {
    reasons.push("missing");
  } else {
    if (fieldString(rec, f.embeddingSpec).trim() !== cfg.specId) reasons.push("spec_changed");
    if (fieldString(rec, f.embeddingHash).trim().toLowerCase() !== hash) reasons.push("content_changed");
    if (!parseVectorJson(embeddingJson, cfg.embedding.dimensions).ok) reasons.push("invalid_vector");
  }
  return { reasons, text, hash };
}

function isTransient(err: unknown): err is UpstreamError {
  return err instanceof UpstreamError && ["rate_limited", "server", "network", "timeout"].includes(err.kind);
}

/** レート制限・一時障害に対する上限付き指数バックオフ。 */
async function withBackoff<T>(fn: () => Promise<T>, opts: Required<Pick<IndexOptions, "sleep" | "maxBackoffAttempts">>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err) || attempt >= opts.maxBackoffAttempts) throw err;
      const base = err.retryAfterSeconds !== undefined ? err.retryAfterSeconds * 1000 : 500 * 2 ** (attempt - 1);
      const delay = Math.min(30_000, base) + Math.floor(Math.random() * 250);
      await opts.sleep(delay);
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof UpstreamError) {
    return `${err.service}:${err.kind}${err.status ? `:${err.status}` : ""}${err.code ? `:${err.code}` : ""}`;
  }
  return err instanceof Error ? err.name : "unknown_error";
}

export async function runIndex(cfg: CliConfig, opts: IndexOptions = {}): Promise<IndexReport> {
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? ((line: string) => console.log(line));
  const now = opts.now ?? (() => new Date());
  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const maxConflictRetries = opts.maxConflictRetries ?? 2;
  const backoff = { sleep, maxBackoffAttempts: opts.maxBackoffAttempts ?? 5 };
  const f = cfg.fields;
  const readFields = ["$revision", f.category, f.question, f.answer, f.embedding, f.embeddingSpec, f.embeddingHash];
  const call = { fetch: opts.fetch };

  if (opts.ids !== undefined && opts.ids.length === 0) {
    // 空配列を「条件なし＝全件」として扱わない
    throw new Error("ids is empty; omit it to process all records");
  }
  const ids = opts.ids?.map((id) => {
    if (!/^\d+$/.test(id)) throw new Error(`invalid record id: ${id}`);
    return String(Number(id));
  });
  const condition = ids && ids.length > 0 ? `$id in (${ids.join(", ")})` : undefined;

  const report: IndexReport = { planned: [], updated: [], skipped: [], conflicts: [], failed: [], dryRun: !!opts.dryRun };

  const { records } = await withBackoff(() => fetchAllRecords(cfg.kintone, readFields, { ...call, condition }), backoff);
  if (ids) {
    const found = new Set(records.map((r) => fieldString(r, "$id")));
    for (const id of ids) if (!found.has(id)) report.failed.push({ id, reason: "not_found" });
  }

  // 差分判定
  const targets: { id: string; rec: KintoneRecord }[] = [];
  for (const rec of records) {
    const id = fieldString(rec, "$id");
    const ev = await evaluateRecord(rec, cfg, !!opts.force);
    if (ev.error) {
      report.failed.push({ id, reason: ev.error });
      continue;
    }
    if (ev.reasons.length === 0) {
      report.skipped.push(id);
      continue;
    }
    report.planned.push({ id, reasons: ev.reasons });
    targets.push({ id, rec });
  }

  log(`対象 ${records.length} 件 / 生成予定 ${targets.length} 件 / 変更なし ${report.skipped.length} 件 / 検証エラー ${report.failed.length} 件`);
  for (const p of report.planned) log(`  #${p.id}: ${p.reasons.join(",")}`);
  for (const e of report.failed) log(`  #${e.id}: ERROR ${e.reason}`);
  if (opts.dryRun) return report;

  const refetch = async (id: string): Promise<KintoneRecord | undefined> => {
    const { records: rs } = await withBackoff(
      () => fetchAllRecords(cfg.kintone, readFields, { ...call, condition: `$id = ${id}` }),
      backoff,
    );
    return rs[0];
  };

  const processOne = async ({ id, rec: initial }: { id: string; rec: KintoneRecord }) => {
    let rec: KintoneRecord | undefined = initial;
    const vectorsByHash = new Map<string, number[]>();
    for (let attempt = 0; attempt <= maxConflictRetries; attempt++) {
      if (!rec) {
        report.failed.push({ id, reason: "deleted_during_update" });
        return;
      }
      const ev = await evaluateRecord(rec, cfg, !!opts.force);
      if (ev.error) {
        report.failed.push({ id, reason: ev.error });
        return;
      }
      if (ev.reasons.length === 0) {
        report.skipped.push(id);
        return;
      }

      let vector = vectorsByHash.get(ev.hash);
      if (!vector) {
        const raw = await withBackoff(() => createEmbedding(cfg.embedding, ev.text, call), backoff);
        const check = validateVector(raw, cfg.embedding.dimensions);
        if (!check.ok) {
          report.failed.push({ id, reason: `invalid_embedding_response:${check.reason}` });
          return;
        }
        vector = Array.from(check.vector);
        vectorsByHash.set(ev.hash, vector);
      }
      const json = JSON.stringify(vector);
      if (json.length > MAX_EMBEDDING_JSON_CHARS) {
        report.failed.push({ id, reason: "embedding_json_too_long_for_field" });
        return;
      }

      try {
        await withBackoff(
          () =>
            updateRecord(
              cfg.kintone,
              id,
              fieldString(rec!, "$revision"),
              {
                [f.embedding]: { value: json },
                [f.embeddingSpec]: { value: cfg.specId },
                [f.embeddingHash]: { value: ev.hash },
                [f.embeddedAt]: { value: now().toISOString().replace(/\.\d{3}Z$/, "Z") },
              },
              call,
            ),
          backoff,
        );
        report.updated.push(id);
        return;
      } catch (err) {
        if (err instanceof UpstreamError && err.kind === "conflict") {
          if (attempt === maxConflictRetries) break;
          log(`  #${id}: revision競合。再取得して再評価します（${attempt + 1}/${maxConflictRetries}）`);
          rec = await refetch(id);
          continue;
        }
        throw err;
      }
    }
    report.conflicts.push(id);
  };

  // 並列度つきで処理
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    while (cursor < targets.length) {
      const t = targets[cursor++]!;
      try {
        await processOne(t);
      } catch (err) {
        report.failed.push({ id: t.id, reason: describeError(err) });
      }
    }
  });
  await Promise.all(workers);

  const byId = (a: string, b: string) => Number(a) - Number(b);
  report.updated.sort(byId);
  report.skipped.sort(byId);
  report.conflicts.sort(byId);
  report.failed.sort((a, b) => byId(a.id, b.id));
  return report;
}

export function formatReport(r: IndexReport): string {
  const lines = [
    r.dryRun ? "== dry-run 結果（Embedding呼び出し・書き込みなし） ==" : "== 索引結果 ==",
    r.dryRun ? `生成予定: ${r.planned.length} 件 ${r.planned.map((p) => p.id).join(", ")}` : `更新: ${r.updated.length} 件 ${r.updated.join(", ")}`,
    `スキップ: ${r.skipped.length} 件`,
    `競合: ${r.conflicts.length} 件 ${r.conflicts.join(", ")}`,
    `失敗: ${r.failed.length} 件 ${r.failed.map((e) => `${e.id}(${e.reason})`).join(", ")}`,
  ];
  return lines.join("\n");
}

export function exitCodeFor(r: IndexReport): number {
  return r.failed.length > 0 || r.conflicts.length > 0 ? 1 : 0;
}
