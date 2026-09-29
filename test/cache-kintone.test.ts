import { describe, expect, it } from "vitest";
import { UpstreamError } from "../src/shared/errors.ts";
import { fetchAllRecords, kintoneApiUrl, SnapshotTooLargeError } from "../src/shared/kintone.ts";
import type { SnapshotData } from "../src/shared/snapshot.ts";
import { SnapshotCache } from "../src/worker/cache.ts";
import { MockUpstream } from "../scripts/mock-upstream-core.ts";

const empty: SnapshotData = { entries: [], fetchedCount: 0, validCount: 0, invalidCount: 0, invalidReasons: {} };

describe("SnapshotCache", () => {
  it("TTL未満はヒット、TTL以上は refresh として再取得する", async () => {
    let t = 1_000;
    const cache = new SnapshotCache(() => t);
    let loads = 0;
    const loader = async () => ({ ...empty, fetchedCount: ++loads });
    expect((await cache.get("k", 60_000, loader)).status).toBe("miss");
    t += 59_999;
    const hit = await cache.get("k", 60_000, loader);
    expect(hit.status).toBe("hit");
    expect(loads).toBe(1);
    t += 1;
    const refreshed = await cache.get("k", 60_000, loader);
    expect(refreshed.status).toBe("refresh");
    expect(refreshed.snapshot.fetchedCount).toBe(2);
  });

  it("同時ミスは1回の取得にまとめる", async () => {
    const cache = new SnapshotCache();
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const loader = async () => {
      loads++;
      await gate;
      return empty;
    };
    const ps = Array.from({ length: 5 }, () => cache.get("k", 60_000, loader));
    release();
    const results = await Promise.all(ps);
    expect(loads).toBe(1);
    expect(results.every((r) => r.status === "miss")).toBe(true);
  });

  it("失敗時はPromiseを解放し、期限切れデータを暗黙に使わず、次の呼び出しで回復する", async () => {
    let t = 0;
    const cache = new SnapshotCache(() => t);
    await cache.get("k", 1_000, async () => ({ ...empty, fetchedCount: 1 }));
    t = 5_000;
    await expect(cache.get("k", 1_000, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(cache.peek("k", 1_000)).toBeUndefined();
    const ok = await cache.get("k", 1_000, async () => ({ ...empty, fetchedCount: 2 }));
    expect(ok.snapshot.fetchedCount).toBe(2);
  });

  it("設定キーが変われば旧スナップショットを使わない", async () => {
    const cache = new SnapshotCache();
    await cache.get("k1", 60_000, async () => empty);
    expect((await cache.get("k2", 60_000, async () => empty)).status).toBe("miss");
  });
});

describe("kintone fetchAllRecords", () => {
  const cfg = { baseUrl: "https://mock.cybozu.test", appId: "146", apiToken: "mock-token" };

  it("ページ境界（500件）を超えても欠落・重複しない", async () => {
    const mock = new MockUpstream();
    mock.addFaq(
      Array.from({ length: 1203 }, (_, i) => ({ id: i * 2 + 1, category: "c", question: `q${i}`, answer: `a${i}` })),
    );
    const { records, requests } = await fetchAllRecords(cfg, ["question"], { fetch: mock.fetch });
    expect(records).toHaveLength(1203);
    expect(requests).toBe(3);
    const ids = records.map((r) => Number(r.$id!.value));
    expect(new Set(ids).size).toBe(1203);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("ちょうど500件でも次ページを確認して終了する", async () => {
    const mock = new MockUpstream();
    mock.addFaq(Array.from({ length: 500 }, (_, i) => ({ id: i + 1, category: "c", question: "q", answer: "a" })));
    const { records, requests } = await fetchAllRecords(cfg, ["question"], { fetch: mock.fetch });
    expect(records).toHaveLength(500);
    expect(requests).toBe(2);
  });

  it("ゲストスペースURLを組み立てる", () => {
    expect(kintoneApiUrl({ ...cfg, guestSpaceId: "7" }, "records.json")).toBe(
      "https://mock.cybozu.test/k/guest/7/v1/records.json",
    );
    expect(kintoneApiUrl(cfg, "records.json")).toBe("https://mock.cybozu.test/k/v1/records.json");
  });

  it("累計サイズ上限を超えたら SnapshotTooLargeError", async () => {
    const mock = new MockUpstream();
    mock.addFaq([{ id: 1, category: "c", question: "q", answer: "x".repeat(5000) }]);
    await expect(fetchAllRecords(cfg, ["answer"], { fetch: mock.fetch, maxBytes: 1000 })).rejects.toBeInstanceOf(
      SnapshotTooLargeError,
    );
  });

  it("上流の認証失敗を auth として分類する", async () => {
    const mock = new MockUpstream();
    const err = await fetchAllRecords({ ...cfg, apiToken: "bad" }, ["question"], { fetch: mock.fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).toMatchObject({ service: "kintone", kind: "auth", status: 401 });
  });
});
