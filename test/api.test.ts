import { beforeEach, describe, expect, it } from "vitest";
import { MockUpstream } from "../scripts/mock-upstream-core.ts";
import { SAMPLE_FAQ } from "../scripts/sample-faq.ts";
import { createApp, type App } from "../src/worker/app.ts";
import type { Env } from "../src/worker/config.ts";
import { API_KEY, DIMS, SPEC_ID, searchRequest, testEnv } from "./helpers/env.ts";

let mock: MockUpstream;
let app: App;
let logs: Record<string, unknown>[];
const env = testEnv();

beforeEach(async () => {
  mock = new MockUpstream();
  mock.addFaq(SAMPLE_FAQ);
  await mock.preindex(SPEC_ID, DIMS);
  logs = [];
  app = createApp({ fetch: mock.fetch, log: (e) => logs.push(e) });
});

async function search(body: unknown, e: Env = env, init?: Parameters<typeof searchRequest>[1]) {
  const res = await app.fetch(searchRequest(body, init), e);
  return { res, json: (await res.json()) as any };
}

describe("認証・入力検証", () => {
  it("不正キー・未指定キーは外部APIを呼ぶ前に401", async () => {
    for (const key of ["wrong", null]) {
      const { res, json } = await search({ query: "パスワード" }, env, { key });
      expect(res.status).toBe(401);
      expect(json.error).toMatchObject({ code: "UNAUTHORIZED", retryable: false });
    }
    expect(mock.counts).toMatchObject({ kintoneGet: 0, embedding: 0 });
  });

  it.each<[unknown, string]>([
    [{}, "query必須"],
    [{ query: "   " }, "空白のみ"],
    [{ query: "あ".repeat(1001) }, "1001文字"],
    [{ query: "x", limit: 0 }, "limit下限"],
    [{ query: "x", limit: 6 }, "limit上限"],
    [{ query: "x", limit: 1.5 }, "limit非整数"],
    [{ query: "x", category: "" }, "category空"],
    [{ query: "x", category: "あ".repeat(101) }, "category長"],
    [{ query: "x", request_id: "has space" }, "request_id形式"],
    [{ query: "x", threshold: 0.1 }, "未知フィールド"],
    [["x"], "配列"],
  ])("400 INVALID_REQUEST: %j (%s)", async (body) => {
    const { res, json } = await search(body);
    expect(res.status).toBe(400);
    expect(json.error.code).toBe("INVALID_REQUEST");
    expect(mock.counts.embedding).toBe(0);
  });

  it("壊れたJSONは400、JSON以外は415、16KiB超は413", async () => {
    expect((await search(null, env, { raw: "{" })).res.status).toBe(400);
    expect((await search({ query: "x" }, env, { contentType: "text/plain" })).res.status).toBe(415);
    const big = await search(null, env, { raw: JSON.stringify({ query: "x", pad: "a".repeat(17 * 1024) }) });
    expect(big.res.status).toBe(413);
    expect(big.json.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("1000文字ちょうどは受け付ける、null の任意項目は省略扱い", async () => {
    const { res } = await search({ query: "あ".repeat(1000), category: null, limit: null, request_id: null });
    expect(res.status).toBe(200);
  });

  it("エラー時もクライアントの request_id を返す", async () => {
    const { json } = await search({ query: "x", limit: 99, request_id: "req-1" });
    expect(json.request_id).toBe("req-1");
  });
});

describe("検索", () => {
  it("matched: FAQ本文・スコア・meta を返し、no-store を付ける", async () => {
    const { res, json } = await search({ query: "パスワードを忘れたので再設定したい", request_id: "req-example-001" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(json.request_id).toBe("req-example-001");
    expect(["matched", "ambiguous"]).toContain(json.status);
    expect(json.results[0]).toMatchObject({ id: "1", category: "アカウント" });
    expect(json.results[0].answer).toContain("再設定用リンク");
    expect(json.meta).toMatchObject({ cache: "miss", embedding_spec: SPEC_ID, degraded: false });
    expect(json.meta.snapshot_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Object.keys(json.meta.timings_ms).sort()).toEqual(["embedding", "faq_load", "similarity", "total"]);
  });

  it("request_id 未指定はサーバー生成", async () => {
    const { json } = await search({ query: "月額料金" });
    expect(json.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("キャッシュ期限内は kintone を再取得せず、期限後に取得する", async () => {
    const e = testEnv({ CACHE_TTL_SECONDS: "1" });
    expect((await search({ query: "月額料金" }, e)).json.meta.cache).toBe("miss");
    const hit = await search({ query: "解約" }, e);
    expect(hit.json.meta.cache).toBe("hit");
    expect(hit.json.meta.timings_ms.faq_load).toBe(0);
    expect(mock.counts.kintoneGet).toBe(1);
    await new Promise((r) => setTimeout(r, 1_050));
    expect((await search({ query: "解約" }, e)).json.meta.cache).toBe("refresh");
    expect(mock.counts.kintoneGet).toBe(2);
  });

  it("同時ミスでも kintone 取得は1回", async () => {
    mock.faults.kintoneDelayMs = 50;
    const rs = await Promise.all(Array.from({ length: 5 }, () => search({ query: "月額料金" })));
    expect(rs.every((r) => r.res.status === 200)).toBe(true);
    expect(mock.counts.kintoneGet).toBe(1);
    expect(mock.counts.embedding).toBe(5);
  });

  it("カテゴリ完全一致・limit を守る", async () => {
    const { json } = await search({ query: "設定", category: "AI・設定", limit: 1 });
    for (const r of json.results) expect(r.category).toBe("AI・設定");
    if (json.status === "matched") expect(json.results).toHaveLength(1);
  });

  it("存在しないカテゴリは no_match / empty_category（kintoneクエリに入力を埋め込まない）", async () => {
    const { json } = await search({ query: "料金", category: '" or $id > 0 or "' });
    expect(json).toMatchObject({ status: "no_match", results: [], meta: { reason: "empty_category" } });
  });

  it("しきい値未満は no_match / below_threshold", async () => {
    const { json } = await search({ query: "量子コンピュータの冷却方式" }, testEnv({ MIN_SIMILARITY: "0.95" }));
    expect(json).toMatchObject({ status: "no_match", results: [], meta: { reason: "below_threshold" } });
  });

  it("本文更新後の古いベクトルは除外して degraded=true", async () => {
    mock.editField(1, "answer", "変更された回答");
    const { json } = await search({ query: "パスワードを忘れた" });
    expect(json.meta.degraded).toBe(true);
    expect(json.results.map((r: any) => r.id)).not.toContain("1");
    expect(logs.at(-1)).toMatchObject({ invalid_reasons: { hash_mismatch: 1 } });
  });

  it("FAQ削除はTTL後の取得で反映される", async () => {
    const e = testEnv({ CACHE_TTL_SECONDS: "0" });
    expect((await search({ query: "録音データの保存期間" }, e)).json.results.map((r: any) => r.id)).toContain("11");
    mock.records.delete(11);
    const after = await search({ query: "録音データの保存期間" }, e);
    expect(after.json.results.map((r: any) => r.id)).not.toContain("11");
  });

  it("キャッシュが全く効かなくても正しく検索できる", async () => {
    const e = testEnv({ CACHE_TTL_SECONDS: "0" });
    for (let i = 0; i < 3; i++) {
      const { res, json } = await search({ query: "月額料金はいくら" }, e);
      expect(res.status).toBe(200);
      expect(json.meta.cache).not.toBe("hit");
      expect(json.results[0].id).toBe("4");
    }
  });

  it("標準ログに検索文・FAQ本文・キーを出さない", async () => {
    await search({ query: "パスワードを忘れた" });
    const line = JSON.stringify(logs);
    expect(line).not.toContain("パスワード");
    expect(line).not.toContain("再設定用リンク");
    expect(line).not.toContain("test-search-key");
    expect(logs.at(-1)).toMatchObject({ http_status: 200, cache: "miss", fetched_count: 12, valid_count: 12 });
  });
});

describe("異常系の分類", () => {
  it("有効ベクトルが1件もなければ 503 INDEX_NOT_READY", async () => {
    const m = new MockUpstream();
    m.addFaq(SAMPLE_FAQ); // 未索引
    const a = createApp({ fetch: m.fetch, log: () => {} });
    const res = await a.fetch(searchRequest({ query: "x" }), env);
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error.code).toBe("INDEX_NOT_READY");
  });

  it("FAQが0件でも 503 INDEX_NOT_READY（no_match にしない）", async () => {
    const a = createApp({ fetch: new MockUpstream().fetch, log: () => {} });
    const res = await a.fetch(searchRequest({ query: "x" }), env);
    expect(res.status).toBe(503);
  });

  it("上流の認証失敗は401にせず 502", async () => {
    const { res, json } = await search({ query: "x" }, testEnv({ EMBEDDING_API_KEY: "bad" }));
    expect(res.status).toBe(502);
    expect(json.error).toMatchObject({ code: "EMBEDDING_FAILED", retryable: false });
    app = createApp({ fetch: mock.fetch, log: () => {} }); // キャッシュなしの isolate
    const k = await search({ query: "x" }, testEnv({ KINTONE_READ_API_TOKEN: "bad" }));
    expect(k.res.status).toBe(502);
    expect(k.json.error).toMatchObject({ code: "KINTONE_FAILED", retryable: false });
  });

  it("上流の429は 503 UPSTREAM_RATE_LIMITED", async () => {
    mock.faults.embeddingStatus = 429;
    const { res, json } = await search({ query: "x" });
    expect(res.status).toBe(503);
    expect(json.error).toMatchObject({ code: "UPSTREAM_RATE_LIMITED", retryable: true });
  });

  it("上流の5xxは 502 retryable", async () => {
    mock.faults.kintoneStatus = 500;
    const { res, json } = await search({ query: "x" });
    expect(res.status).toBe(502);
    expect(json.error).toMatchObject({ code: "KINTONE_FAILED", retryable: true });
  });

  it("全体期限超過は 504 SEARCH_TIMEOUT（no_match にしない）、各処理は期限内に打ち切る", async () => {
    mock.faults.embeddingDelayMs = 5_000;
    const e = testEnv({ SEARCH_TIMEOUT_MS: "150", UPSTREAM_TIMEOUT_MS: "2000" });
    const t0 = Date.now();
    const { res, json } = await search({ query: "x" }, e);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(res.status).toBe(504);
    expect(json.error).toMatchObject({ code: "SEARCH_TIMEOUT", retryable: true });
  });

  it("ボディ送信が途中で止まっても全体期限で 504 を返す", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"query":'));
        // close しない = 送信途中で停止
      },
    });
    const req = new Request("https://faq.example.test/v1/faq/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: stalled,
      duplex: "half", // Node の fetch 実装でストリームボディを送るために必要
    });
    const t0 = Date.now();
    const res = await app.fetch(req, testEnv({ SEARCH_TIMEOUT_MS: "100" }));
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(res.status).toBe(504);
    expect(((await res.json()) as any).error.code).toBe("SEARCH_TIMEOUT");
    expect(mock.counts.embedding).toBe(0);
  });

  it("上流個別期限（UPSTREAM_TIMEOUT_MS）でも 504", async () => {
    mock.faults.kintoneDelayMs = 5_000;
    const { res } = await search({ query: "x" }, testEnv({ UPSTREAM_TIMEOUT_MS: "100" }));
    expect(res.status).toBe(504);
  });

  describe("Embedding のヘッジ（EMBEDDING_HEDGE_MS）", () => {
    const hedgeEnv = testEnv({ EMBEDDING_HEDGE_MS: "100", UPSTREAM_TIMEOUT_MS: "2000" });
    const lastLog = () => logs.at(-1)!;

    it("1本目が詰まったら2本目の応答で返し、1本目は中止する", async () => {
      mock.faults.embeddingDelaysMs = [5_000];
      const t0 = Date.now();
      const { res } = await search({ query: "月額料金" }, hedgeEnv);
      expect(Date.now() - t0).toBeLessThan(1_000);
      expect(res.status).toBe(200);
      expect(mock.counts.embedding).toBe(1); // 中止した1本目は応答まで進まない
      expect(lastLog()).toMatchObject({ embedding_attempts: 2, embedding_winner: "hedge" });
    });

    it("1本目が期限内に返ればヘッジしない", async () => {
      const { res } = await search({ query: "月額料金" }, hedgeEnv);
      expect(res.status).toBe(200);
      expect(lastLog()).toMatchObject({ embedding_attempts: 1, embedding_winner: "primary" });
    });

    it("ヘッジ前の失敗（認証エラー）は二重に送らない", async () => {
      const { res } = await search({ query: "x" }, testEnv({ EMBEDDING_HEDGE_MS: "100", EMBEDDING_API_KEY: "bad" }));
      expect(res.status).toBe(502);
      await new Promise((r) => setTimeout(r, 150));
      expect(lastLog()).toMatchObject({ embedding_attempts: 1, upstream_error: "embedding:auth:401" });
    });

    it("2本とも詰まれば上流個別期限で 504", async () => {
      mock.faults.embeddingDelayMs = 5_000;
      const { res } = await search({ query: "x" }, testEnv({ EMBEDDING_HEDGE_MS: "50", UPSTREAM_TIMEOUT_MS: "200" }));
      expect(res.status).toBe(504);
      expect(lastLog()).toMatchObject({ embedding_attempts: 2, upstream_error: "embedding:timeout" });
    });

    it("既定（0）ではヘッジしない", async () => {
      mock.faults.embeddingDelaysMs = [300];
      const { res } = await search({ query: "x" });
      expect(res.status).toBe(200);
      expect(lastLog()).toMatchObject({ embedding_attempts: 1, embedding_winner: "primary" });
    });
  });

  it("取得失敗の後、次の検索で回復する", async () => {
    mock.faults.kintoneStatus = 503;
    expect((await search({ query: "月額料金" })).res.status).toBe(502);
    mock.faults.kintoneStatus = undefined;
    expect((await search({ query: "月額料金" })).res.status).toBe(200);
  });

  it("Embedding応答のNaN・次元不一致は 502 EMBEDDING_FAILED", async () => {
    mock.faults.embeddingOverride = [1, 2, 3];
    expect((await search({ query: "x" })).json.error.code).toBe("EMBEDDING_FAILED");
  });

  it("スナップショット上限超過は安全に 503", async () => {
    const { res, json } = await search({ query: "x" }, testEnv({ MAX_SNAPSHOT_BYTES: "1000" }));
    expect(res.status).toBe(503);
    expect(json.error.code).toBe("SNAPSHOT_TOO_LARGE");
  });

  it("しきい値未設定などの設定不備は 500 で詳細を返さない", async () => {
    const { res, json } = await search({ query: "x" }, testEnv({ MIN_SIMILARITY: undefined }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(json)).not.toContain("MIN_SIMILARITY");
    expect(logs.at(-1)).toMatchObject({ config_error: ["MIN_SIMILARITY is required"] });
  });

  it("レート制限超過は 429 + Retry-After", async () => {
    const limiter = { limit: async () => ({ success: false }) };
    const { res, json } = await search({ query: "x" }, testEnv({ SEARCH_RATE_LIMITER: limiter }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(mock.counts.embedding).toBe(0);
  });
});

describe("ルーティング", () => {
  it("GET /healthz は設定やFAQに依存せず200で最小情報のみ", async () => {
    const res = await app.fetch(new Request("https://faq.example.test/healthz"), {} as Env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("未知のパスは404、GET検索は405", async () => {
    expect((await app.fetch(new Request("https://faq.example.test/v1/answer"), env)).status).toBe(404);
    const r = await app.fetch(new Request("https://faq.example.test/v1/faq/search"), env);
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("POST");
  });
});

