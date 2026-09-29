import { beforeEach, describe, expect, it } from "vitest";
import { exitCodeFor, runIndex } from "../cli/indexer.ts";
import { MockUpstream } from "../scripts/mock-upstream-core.ts";
import { SAMPLE_FAQ } from "../scripts/sample-faq.ts";
import { createApp } from "../src/worker/app.ts";
import { DIMS, searchRequest, SPEC_ID, testCliConfig, testEnv } from "./helpers/env.ts";

let mock: MockUpstream;
const cfg = testCliConfig();
const quiet = { log: () => {}, sleep: async () => {} };

beforeEach(() => {
  mock = new MockUpstream();
  mock.addFaq(SAMPLE_FAQ);
});

describe("index:faq", () => {
  it("--dry-run は Embedding 呼び出し・書き込みを行わない", async () => {
    const r = await runIndex(cfg, { ...quiet, fetch: mock.fetch, dryRun: true });
    expect(r.planned).toHaveLength(12);
    expect(r.planned[0]!.reasons).toEqual(["missing"]);
    expect(mock.counts).toMatchObject({ embedding: 0, kintonePut: 0 });
  });

  it("未生成を生成し、4項目だけを更新する。2回目は差分なし", async () => {
    const before = { ...mock.records.get(1)!.values };
    const r1 = await runIndex(cfg, { ...quiet, fetch: mock.fetch });
    expect(r1.updated).toHaveLength(12);
    expect(exitCodeFor(r1)).toBe(0);
    const after = mock.records.get(1)!.values;
    expect(after.question).toBe(before.question);
    expect(after.answer).toBe(before.answer);
    expect(after.embedding_spec).toBe(SPEC_ID);
    expect(after.embedding_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(after.embedded_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(JSON.parse(after.embedding!)).toHaveLength(DIMS);

    const embeddingCalls = mock.counts.embedding;
    const r2 = await runIndex(cfg, { ...quiet, fetch: mock.fetch });
    expect(r2.updated).toHaveLength(0);
    expect(r2.skipped).toHaveLength(12);
    expect(mock.counts.embedding).toBe(embeddingCalls);
  });

  it("本文変更・仕様ID変更・ベクトル破損だけを再生成する", async () => {
    await mock.preindex(SPEC_ID, DIMS);
    mock.editField(2, "answer", "新しい回答");
    mock.editField(3, "embedding_spec", "old-spec");
    mock.editField(4, "embedding", "[1,2");
    const r = await runIndex(cfg, { ...quiet, fetch: mock.fetch });
    expect(r.planned).toEqual([
      { id: "2", reasons: ["content_changed"] },
      { id: "3", reasons: ["spec_changed"] },
      { id: "4", reasons: ["invalid_vector"] },
    ]);
    expect(r.updated).toEqual(["2", "3", "4"]);
  });

  it("本文更新後は古いベクトルを使わず、CLI再生成後に検索できる", async () => {
    await mock.preindex(SPEC_ID, DIMS);
    mock.editField(5, "answer", "解約は電話窓口でのみ受け付けます。");
    const app = createApp({ fetch: mock.fetch, log: () => {} });
    const env = testEnv({ CACHE_TTL_SECONDS: "0" });
    const q = { query: "解約は電話窓口で受け付けますか" };
    const before = (await (await app.fetch(searchRequest(q), env)).json()) as any;
    expect(before.results.map((r: any) => r.id)).not.toContain("5");
    expect(before.meta.degraded).toBe(true);

    await runIndex(cfg, { ...quiet, fetch: mock.fetch, ids: ["5"] });
    const after = (await (await app.fetch(searchRequest(q), env)).json()) as any;
    expect(after.meta.degraded).toBe(false);
    expect(after.results[0].id).toBe("5");
    expect(after.results[0].answer).toContain("電話窓口");
  });

  it("--id は指定レコードだけ、存在しないIDは失敗として報告", async () => {
    const r = await runIndex(cfg, { ...quiet, fetch: mock.fetch, ids: ["3", "999"] });
    expect(r.updated).toEqual(["3"]);
    expect(r.failed).toEqual([{ id: "999", reason: "not_found" }]);
    expect(exitCodeFor(r)).toBe(1);
  });

  it("--force は変更がなくても全件再生成する", async () => {
    await mock.preindex(SPEC_ID, DIMS);
    const r = await runIndex(cfg, { ...quiet, fetch: mock.fetch, force: true });
    expect(r.updated).toHaveLength(12);
  });

  it("revision競合時は他者の更新を上書きせず、再取得して再評価する", async () => {
    mock.faults.conflicts = new Map([["1", 1]]);
    const r = await runIndex(cfg, { ...quiet, fetch: mock.fetch, ids: ["1"] });
    expect(r.updated).toEqual(["1"]);
    expect(mock.counts.kintonePut).toBe(2);
    // 本文が変わっていなければ同じベクトルを再利用する（Embedding 1回）
    expect(mock.counts.embedding).toBe(1);
  });

  it("競合が続けば最大2回の再試行後に競合として報告し、非ゼロ終了", async () => {
    mock.faults.conflicts = new Map([["1", 10]]);
    const r = await runIndex(cfg, { ...quiet, fetch: mock.fetch, ids: ["1"] });
    expect(r.conflicts).toEqual(["1"]);
    expect(r.updated).toEqual([]);
    expect(mock.counts.kintonePut).toBe(3);
    expect(exitCodeFor(r)).toBe(1);
  });

  it("競合中に本文が変わった場合は新しい本文でベクトルを作り直す", async () => {
    const originalFetch = mock.fetch;
    let edited = false;
    const f: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.method === "PUT" && !edited) {
        edited = true;
        mock.editField(1, "answer", "競合中に編集された回答");
      }
      return originalFetch(req);
    };
    const r = await runIndex(cfg, { ...quiet, fetch: f, ids: ["1"] });
    expect(r.updated).toEqual(["1"]);
    expect(mock.counts.embedding).toBe(2);
    expect(mock.records.get(1)!.values.answer).toBe("競合中に編集された回答");
  });

  it("入力上限超過はエラー報告し、切り詰めて保存しない", async () => {
    mock.editField(6, "answer", "長".repeat(7000));
    const r = await runIndex(cfg, { ...quiet, fetch: mock.fetch });
    expect(r.failed).toEqual([{ id: "6", reason: "input_too_long" }]);
    expect(mock.records.get(6)!.values.embedding).toBe("");
    expect(exitCodeFor(r)).toBe(1);
  });

  it("上流429はバックオフして再試行し、上限到達で失敗を報告する", async () => {
    mock.faults.embeddingStatus = 429;
    const sleeps: number[] = [];
    const r = await runIndex(cfg, {
      log: () => {},
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetch: mock.fetch,
      ids: ["1"],
      maxBackoffAttempts: 3,
    });
    expect(sleeps).toHaveLength(2);
    expect(r.failed).toEqual([{ id: "1", reason: "embedding:rate_limited:429:mock_error" }]);
  });

  it("ログにFAQ本文・キーを出さない", async () => {
    const lines: string[] = [];
    await runIndex(cfg, { sleep: async () => {}, log: (l) => lines.push(l), fetch: mock.fetch, dryRun: true });
    const all = lines.join("\n");
    expect(all).not.toContain("パスワード");
    expect(all).not.toContain("mock-token");
  });
});
