/**
 * isolate 内メモリの FAQ スナップショットキャッシュ（仕様 9.1）。
 * - TTL 未満ならヒット、以上なら期限切れ。期限切れデータでは回答しない。
 * - 同一 isolate 内の同時取得を1つの Promise にまとめ、失敗時も解放する。
 * - 取得・検証がすべて完了してから一括で差し替える。
 * メモリは isolate 単位で分離され保持期間も保証されないため、キャッシュなしでも動作することが前提。
 */
import type { SnapshotData } from "../shared/snapshot.ts";

export type CacheStatus = "hit" | "miss" | "refresh";

export interface CachedSnapshot extends SnapshotData {
  key: string;
  /** 取得完了時刻（epoch ms） */
  loadedAt: number;
}

export interface CacheResult {
  snapshot: CachedSnapshot;
  status: CacheStatus;
}

export class SnapshotCache {
  private current: CachedSnapshot | undefined;
  private inflight: { key: string; promise: Promise<CachedSnapshot> } | undefined;
  /** テスト・監視用：ローダー実行回数 */
  loadCount = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** 期限内なら同期的に返す（ヒット時に Promise を待たない）。 */
  peek(key: string, ttlMs: number): CachedSnapshot | undefined {
    const cur = this.current;
    if (cur && cur.key === key && this.now() - cur.loadedAt < ttlMs) return cur;
    return undefined;
  }

  get(key: string, ttlMs: number, loader: () => Promise<SnapshotData>): Promise<CacheResult> {
    const hit = this.peek(key, ttlMs);
    if (hit) return Promise.resolve({ snapshot: hit, status: "hit" });

    const status: CacheStatus = this.current && this.current.key === key ? "refresh" : "miss";

    if (!this.inflight || this.inflight.key !== key) {
      this.loadCount++;
      const promise = loader().then((data) => {
        const snap: CachedSnapshot = { ...data, key, loadedAt: this.now() };
        this.current = snap;
        return snap;
      });
      const entry = { key, promise };
      this.inflight = entry;
      promise
        .finally(() => {
          if (this.inflight === entry) this.inflight = undefined;
        })
        .catch(() => {
          // 失敗は各呼び出し元へ伝わる。ここでは解放のみ。
        });
    }
    return this.inflight.promise.then((snapshot) => ({ snapshot, status }));
  }

  clear(): void {
    this.current = undefined;
    this.inflight = undefined;
  }
}
