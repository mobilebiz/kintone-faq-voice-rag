/**
 * 検索APIの性能測定（仕様 11.1）。実際の通話サーバー配置先から実行すること。
 *
 *   npm run bench -- --concurrency 1,5,10 --requests 100 [--queries eval/eval-set.local.json]
 *
 * - クライアント側の往復時間と、応答 meta.cache / meta.timings_ms を記録する。
 * - ヒット／ミス（miss+refresh）を分けて p50 / p95 を出す。キャッシュ状態は実際の meta で判定する。
 * - CPU時間は Cloudflare ダッシュボード（Workers Observability）または `wrangler tail` で確認する。
 * - 実接続時は検索1回ごとに Embedding API の料金が発生する（requests × 条件数）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    concurrency: { type: "string", default: "1,5,10" },
    requests: { type: "string", default: "100" },
    queries: { type: "string" },
    timeout: { type: "string", default: "3000" },
  },
});

const url = (values.url ?? process.env.SEARCH_API_URL ?? "").replace(/\/+$/, "");
const key = process.env.FAQ_SEARCH_API_KEY ?? "";
if (!url) throw new Error("--url または SEARCH_API_URL を指定してください");
const levels = values.concurrency!.split(",").map(Number);
const perLevel = Number(values.requests);
const clientTimeout = Number(values.timeout);

let queries = ["パスワードを忘れた", "月額料金はいくらですか", "解約の手続き", "同時に何回線使えますか", "録音の保存期間"];
if (values.queries) {
  const parsed = JSON.parse(await readFile(values.queries, "utf8")) as (string | { query: string })[];
  queries = parsed.map((q) => (typeof q === "string" ? q : q.query));
}

interface Sample {
  ms: number;
  http: number;
  cache?: string;
  status?: string;
  server_total?: number;
  embedding?: number;
  faq_load?: number;
  error?: string;
}

async function one(i: number): Promise<Sample> {
  const t = performance.now();
  try {
    const res = await fetch(`${url}/v1/faq/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: queries[i % queries.length], request_id: `bench-${i}` }),
      signal: AbortSignal.timeout(clientTimeout),
    });
    const body = (await res.json()) as any;
    return {
      ms: performance.now() - t,
      http: res.status,
      cache: body.meta?.cache,
      status: body.status,
      server_total: body.meta?.timings_ms?.total,
      embedding: body.meta?.timings_ms?.embedding,
      faq_load: body.meta?.timings_ms?.faq_load,
      error: body.error?.code,
    };
  } catch (e) {
    return { ms: performance.now() - t, http: 0, error: e instanceof Error ? e.name : "error" };
  }
}

const pct = (arr: number[], p: number) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!);
};
const summarize = (samples: Sample[]) => ({
  n: samples.length,
  p50: pct(samples.map((s) => s.ms), 50),
  p95: pct(samples.map((s) => s.ms), 95),
  server_p50: pct(samples.flatMap((s) => (s.server_total !== undefined ? [s.server_total] : [])), 50),
  server_p95: pct(samples.flatMap((s) => (s.server_total !== undefined ? [s.server_total] : [])), 95),
  embedding_p95: pct(samples.flatMap((s) => (s.embedding !== undefined ? [s.embedding] : [])), 95),
});

const results: Record<string, unknown>[] = [];
let counter = 0;
for (const c of levels) {
  const samples: Sample[] = [];
  let issued = 0;
  await Promise.all(
    Array.from({ length: c }, async () => {
      while (issued < perLevel) {
        issued++;
        samples.push(await one(counter++));
      }
    }),
  );
  const ok = samples.filter((s) => s.http === 200);
  const hits = ok.filter((s) => s.cache === "hit");
  const misses = ok.filter((s) => s.cache === "miss" || s.cache === "refresh");
  const row = {
    concurrency: c,
    requests: samples.length,
    error_rate: (samples.length - ok.length) / samples.length,
    errors: Object.entries(samples.filter((s) => s.http !== 200).reduce<Record<string, number>>((a, s) => ((a[`${s.http}:${s.error}`] = (a[`${s.http}:${s.error}`] ?? 0) + 1), a), {})),
    cache_hit_rate: ok.length ? hits.length / ok.length : null,
    all: summarize(ok),
    hit: summarize(hits),
    miss: summarize(misses),
    samples,
  };
  results.push(row);
  console.log(
    `同時${c}: n=${row.requests} err=${(row.error_rate * 100).toFixed(1)}% hit率=${row.cache_hit_rate === null ? "-" : (row.cache_hit_rate * 100).toFixed(0) + "%"} ` +
      `hit p50/p95=${row.hit.p50}/${row.hit.p95}ms (n=${row.hit.n}) miss p50/p95=${row.miss.p50}/${row.miss.p95}ms (n=${row.miss.n})`,
  );
}

console.log("\n目標: ヒット p50≤500ms・p95≤1000ms / ミス p95≤2000ms（設計目標でありSLAではない）");
console.log("ミス側のサンプルが100件未満の場合は、新規デプロイ直後や TTL 満了後に追加測定すること。");
await mkdir("reports", { recursive: true });
const out = `reports/bench-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await writeFile(out, JSON.stringify({ url, created_at: new Date().toISOString(), per_level: perLevel, results }, null, 2));
console.log(`記録: ${out}`);
