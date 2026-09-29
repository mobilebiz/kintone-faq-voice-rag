/**
 * 依存先の疎通確認（仕様 7.3：/healthz ではなく管理CLIで行う）。
 *   npm run check:deps [-- --query "パスワードを忘れた"]
 * - kintone：必要フィールドの存在と、仕様ID・ハッシュが有効なベクトルの件数
 * - Embedding：次元数・有限値
 * - 検索API（SEARCH_API_URL 設定時）：/healthz と、--query 指定時は検索1回
 * FAQ本文・キーは表示しない。
 */
import { parseArgs } from "node:util";
import { createEmbedding } from "../src/shared/embedding.ts";
import { fetchAllRecords } from "../src/shared/kintone.ts";
import { buildSnapshot } from "../src/shared/snapshot.ts";
import { validateVector } from "../src/shared/vector.ts";
import { CliConfigError, loadCliConfig } from "./config.ts";

const { values } = parseArgs({ options: { query: { type: "string" } } });
let ok = true;
const pass = (m: string) => console.log(`OK   ${m}`);
const fail = (m: string) => {
  ok = false;
  console.log(`NG   ${m}`);
};
const errName = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : "unknown");

let cfg;
try {
  cfg = loadCliConfig(process.env, ["KINTONE_READ_API_TOKEN", "KINTONE_WRITE_API_TOKEN"]);
} catch (e) {
  console.error(e instanceof CliConfigError ? `設定エラー:\n${e.message}` : errName(e));
  process.exit(2);
}

// kintone
try {
  const t = Date.now();
  const f = cfg.fields;
  const codes = [f.category, f.question, f.answer, f.embedding, f.embeddingSpec, f.embeddingHash, f.embeddedAt];
  const { records, requests, bytes } = await fetchAllRecords(cfg.kintone, ["$revision", ...codes]);
  pass(`kintone 取得 ${records.length} 件（${requests} リクエスト, ${(bytes / 1024).toFixed(0)} KiB, ${Date.now() - t} ms）`);
  if (records[0]) {
    const missing = codes.filter((c) => !(c in records[0]!));
    if (missing.length) fail(`kintone フィールドが見つからない/閲覧権限がない: ${missing.join(", ")}`);
    else pass("kintone 必要フィールドをすべて取得できた");
  }
  const snap = await buildSnapshot(records, { fields: f, specId: cfg.specId, dimensions: cfg.embedding.dimensions });
  const msg = `有効ベクトル ${snap.validCount}/${snap.fetchedCount} 件 ${JSON.stringify(snap.invalidReasons)}`;
  if (snap.validCount === 0) fail(msg);
  else if (snap.invalidCount > 0) console.log(`WARN ${msg}（npm run index:faq で更新）`);
  else pass(msg);
} catch (e) {
  fail(`kintone: ${errName(e)}`);
}

// Embedding
try {
  const t = Date.now();
  const raw = await createEmbedding(cfg.embedding, "疎通確認");
  const v = validateVector(raw, cfg.embedding.dimensions);
  if (v.ok) pass(`Embedding ${cfg.embedding.model} ${cfg.embedding.dimensions}次元（${Date.now() - t} ms）`);
  else fail(`Embedding 応答が不正: ${v.reason}`);
} catch (e) {
  fail(`Embedding: ${errName(e)}`);
}

// 検索API
const apiUrl = process.env.SEARCH_API_URL?.replace(/\/+$/, "");
if (apiUrl) {
  try {
    const r = await fetch(`${apiUrl}/healthz`);
    if (r.ok) pass(`検索API /healthz ${r.status}`);
    else fail(`検索API /healthz ${r.status}`);
  } catch (e) {
    fail(`検索API /healthz: ${errName(e)}`);
  }
  if (values.query) {
    try {
      const t = Date.now();
      const r = await fetch(`${apiUrl}/v1/faq/search`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.FAQ_SEARCH_API_KEY ?? ""}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: values.query, request_id: "check-deps" }),
      });
      const body = (await r.json()) as { status?: string; meta?: unknown; error?: { code?: string }; results?: { id: string; score: number }[] };
      if (r.ok) {
        pass(`検索API ${r.status} status=${body.status} top=${JSON.stringify(body.results?.map((x) => [x.id, x.score]))} (${Date.now() - t} ms)`);
        console.log(`     meta=${JSON.stringify(body.meta)}`);
      } else fail(`検索API ${r.status} ${body.error?.code}`);
    } catch (e) {
      fail(`検索API: ${errName(e)}`);
    }
  }
} else {
  console.log("SKIP 検索API（SEARCH_API_URL 未設定）");
}

process.exit(ok ? 0 : 1);
