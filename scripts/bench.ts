/**
 * 検索APIの性能測定（仕様 11.1）。実際の通話サーバー配置先から実行すること。
 *
 *   npm run bench -- --concurrency 1,5,10 --requests 40 [--queries eval/eval-set.local.json]
 *
 * - 待ち時間 `--timeout` の既定は呼び出し側（Denwaban の汎用 Webhook 連携）と同じ 5,000ms。
 *   サーバー側の SEARCH_TIMEOUT_MS より短くすると、期限内に返る応答までタイムアウト扱いになる。
 * - APIキー単位のレート制限（既定 60回/60秒）を超えると 429 が混ざり、エラー率が実態より高く出る。
 *   1条件の件数が `--rate-limit` を超えると警告し、条件の間は `--gap` 秒（既定 60）空ける。
 *   wrangler.toml の [[ratelimits]] を一時的に上げたときは `--rate-limit` も合わせる。
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
    requests: { type: "string", default: "40" },
    queries: { type: "string" },
    timeout: { type: "string", default: "5000" },
    "rate-limit": { type: "string", default: "60" },
    gap: { type: "string", default: "60" },
  },
});

const url = (values.url ?? process.env.SEARCH_API_URL ?? "").replace(/\/+$/, "");
const key = process.env.FAQ_SEARCH_API_KEY ?? "";
if (!url) throw new Error("--url または SEARCH_API_URL を指定してください");
const levels = values.concurrency!.split(",").map(Number);
const perLevel = Number(values.requests);
const clientTimeout = Number(values.timeout);
const rateLimit = Number(values["rate-limit"]);
const gapSeconds = Number(values.gap);

if (perLevel > rateLimit) {
  console.warn(
    `警告: 1条件 ${perLevel} 件はレート制限 ${rateLimit}回/60秒を超えるため、429 RATE_LIMITED が混ざります。` +
      `--requests ${rateLimit} 以下にするか、wrangler.toml の [[ratelimits]] を一時的に上げて --rate-limit を合わせてください。\n`,
  );
}

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
for (const [li, c] of levels.entries()) {
  if (li > 0 && gapSeconds > 0) {
    console.log(`（レート制限の窓をまたぐため ${gapSeconds} 秒待機）`);
    await new Promise((r) => setTimeout(r, gapSeconds * 1000));
  }
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
if (results.some((r) => (r.errors as [string, number][]).some(([k]) => k === "429:RATE_LIMITED"))) {
  console.log("429 RATE_LIMITED はレート制限によるもので、検索の失敗ではない。--requests を減らすか --gap を延ばして再測定すること。");
}
console.log("ミス側のサンプルが100件未満の場合は、新規デプロイ直後や TTL 満了後に追加測定すること。");
await mkdir("reports", { recursive: true });
const out = `reports/bench-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await writeFile(out, JSON.stringify({ url, created_at: new Date().toISOString(), per_level: perLevel, timeout_ms: clientTimeout, rate_limit: rateLimit, gap_seconds: gapSeconds, results }, null, 2));
console.log(`記録: ${out}`);
