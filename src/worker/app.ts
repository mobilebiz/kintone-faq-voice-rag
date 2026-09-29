/**
 * FAQ検索API（POST /v1/faq/search、GET /healthz）。
 * 依存（fetch・時計・ログ・キャッシュ）を注入可能にし、テストから同じ実装を検証する。
 */
import { createEmbedding } from "../shared/embedding.ts";
import { UpstreamError } from "../shared/errors.ts";
import { fetchAllRecords, SnapshotTooLargeError } from "../shared/kintone.ts";
import { rank } from "../shared/search.ts";
import { buildSnapshot, type SnapshotData } from "../shared/snapshot.ts";
import { toHex } from "../shared/text.ts";
import { toUnitFloat64, validateVector } from "../shared/vector.ts";
import { verifyApiKey } from "./auth.ts";
import { SnapshotCache, type CacheStatus } from "./cache.ts";
import { ConfigError, loadConfig, snapshotKey, type Env, type WorkerConfig } from "./config.ts";
import { errorResponse, errorStatus, jsonResponse, type ErrorCode } from "./http.ts";
import { isJsonContentType, MAX_BODY_BYTES, readBodyLimited, validateSearchBody } from "./request.ts";

export interface AppDeps {
  cache?: SnapshotCache;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

export interface App {
  fetch(request: Request, env: Env): Promise<Response>;
  cache: SnapshotCache;
}

const SEARCH_PATH = "/v1/faq/search";

class DeadlineExceeded extends Error {
  constructor() {
    super("search deadline exceeded");
    this.name = "DeadlineExceeded";
  }
}

/** Promise を AbortSignal で打ち切る（共有中の取得処理そのものは止めない）。 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DeadlineExceeded());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DeadlineExceeded());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function classifyError(
  err: unknown,
  deadlineHit: boolean,
): { code: ErrorCode; upstream?: string; retryable?: boolean } {
  if (deadlineHit || err instanceof DeadlineExceeded) return { code: "SEARCH_TIMEOUT", upstream: "deadline" };
  if (err instanceof SnapshotTooLargeError) return { code: "SNAPSHOT_TOO_LARGE", upstream: "kintone:too_large" };
  if (err instanceof UpstreamError) {
    const upstream = `${err.service}:${err.kind}${err.status ? `:${err.status}` : ""}`;
    if (err.kind === "timeout") return { code: "SEARCH_TIMEOUT", upstream };
    if (err.kind === "rate_limited") return { code: "UPSTREAM_RATE_LIMITED", upstream };
    // 上流の認証失敗・入力エラーは再試行しても直らない
    const retryable = err.kind === "server" || err.kind === "network";
    return { code: err.service === "embedding" ? "EMBEDDING_FAILED" : "KINTONE_FAILED", upstream, retryable };
  }
  return { code: "INTERNAL_ERROR", upstream: "internal" };
}

export function createApp(deps: AppDeps = {}): App {
  const now = deps.now ?? Date.now;
  const cache = deps.cache ?? new SnapshotCache(now);
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const doFetch: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));

  async function loadSnapshot(cfg: WorkerConfig, timeoutMs: number): Promise<SnapshotData> {
    const signal = AbortSignal.timeout(Math.max(1, timeoutMs));
    const { records } = await fetchAllRecords(
      cfg.kintone,
      [cfg.fields.category, cfg.fields.question, cfg.fields.answer, cfg.fields.embedding, cfg.fields.embeddingSpec, cfg.fields.embeddingHash],
      { fetch: doFetch, signal, maxBytes: cfg.maxSnapshotBytes },
    );
    return buildSnapshot(records, { fields: cfg.fields, specId: cfg.specId, dimensions: cfg.embedding.dimensions });
  }

  async function handleSearch(request: Request, env: Env, traceId: string, started: number): Promise<Response> {
    let requestId = traceId;
    const logEntry: Record<string, unknown> = { event: "faq_search", trace_id: traceId };
    const finish = (res: Response, extra: Record<string, unknown> = {}): Response => {
      log({ ...logEntry, request_id: requestId, http_status: res.status, total_ms: now() - started, ...extra });
      return res;
    };

    let cfg: WorkerConfig;
    try {
      cfg = loadConfig(env);
    } catch (err) {
      const problems = err instanceof ConfigError ? err.problems : ["unknown"];
      return finish(errorResponse(requestId, "INTERNAL_ERROR"), { error_code: "INTERNAL_ERROR", config_error: problems });
    }

    // 認証は外部APIを呼ぶ前、ボディを読む前に行う
    const authHeader = request.headers.get("authorization");
    if (!(await verifyApiKey(authHeader, cfg.apiKey))) {
      return finish(errorResponse(requestId, "UNAUTHORIZED", { headers: { "WWW-Authenticate": "Bearer" } }), {
        error_code: "UNAUTHORIZED",
      });
    }

    // APIキー単位のレート制限（Cloudflare Rate Limiting binding。拠点単位・結果整合で厳密な全体制限ではない）
    if (env.SEARCH_RATE_LIMITER) {
      try {
        const keyHash = toHex(
          new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cfg.apiKey))),
        ).slice(0, 16);
        const { success } = await env.SEARCH_RATE_LIMITER.limit({ key: `faq-search:${keyHash}` });
        if (!success) {
          return finish(
            errorResponse(requestId, "RATE_LIMITED", {
              headers: { "Retry-After": String(cfg.rateLimitRetryAfterSeconds) },
            }),
            { error_code: "RATE_LIMITED" },
          );
        }
      } catch {
        // レート制限基盤の障害では通話を止めない（fail-open）。ログで検知する。
        logEntry.rate_limiter_error = true;
      }
    }

    if (!isJsonContentType(request.headers.get("content-type"))) {
      return finish(errorResponse(requestId, "UNSUPPORTED_MEDIA_TYPE"), { error_code: "UNSUPPORTED_MEDIA_TYPE" });
    }
    // ---- 全体期限を共有する（ボディ受信から開始）----
    const deadlineAt = started + cfg.searchTimeoutMs;
    const remaining = () => Math.max(1, deadlineAt - now());
    const deadline = new AbortController();
    let deadlineHit = false;
    const timer = setTimeout(() => {
      deadlineHit = true;
      deadline.abort();
    }, remaining());

    const timings: Record<string, number> = { embedding: 0, faq_load: 0, similarity: 0 };
    let cacheStatus: CacheStatus = "miss";

    try {
      // ボディ受信も全体期限の内側で行う（送信途中で止まったクライアントを待ち続けない）
      const raw = await readBodyLimited(request, MAX_BODY_BYTES, deadline.signal);
      if (raw === null) {
        return finish(errorResponse(requestId, "PAYLOAD_TOO_LARGE"), { error_code: "PAYLOAD_TOO_LARGE" });
      }
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      } catch {
        return finish(errorResponse(requestId, "INVALID_REQUEST", { message: "JSONを解析できません。" }), {
          error_code: "INVALID_REQUEST",
        });
      }
      const v = validateSearchBody(body, cfg.defaultLimit, cfg.maxLimit);
      if (!v.ok) {
        if (v.requestId) requestId = v.requestId;
        return finish(errorResponse(requestId, "INVALID_REQUEST", { message: v.message }), {
          error_code: "INVALID_REQUEST",
        });
      }
      const req = v.value;
      if (req.requestId) requestId = req.requestId;
      logEntry.request_id_source = req.requestId ? "client" : "server";

      const key = snapshotKey(cfg);

      // 検索文Embedding と FAQ取得を並列に開始する
      const embeddingTask = (async () => {
        const t = now();
        const signal = AbortSignal.any([deadline.signal, AbortSignal.timeout(Math.min(cfg.upstreamTimeoutMs, remaining()))]);
        try {
          return await createEmbedding(cfg.embedding, req.query, { fetch: doFetch, signal });
        } finally {
          timings.embedding = now() - t;
        }
      })();

      const snapshotTask = (async () => {
        const t = now();
        const hit = cache.peek(key, cfg.cacheTtlMs);
        if (hit) {
          cacheStatus = "hit";
          return hit;
        }
        const loadTimeout = Math.min(cfg.upstreamTimeoutMs, remaining());
        try {
          const result = await raceAbort(
            cache.get(key, cfg.cacheTtlMs, () => loadSnapshot(cfg, loadTimeout)),
            deadline.signal,
          );
          cacheStatus = result.status;
          return result.snapshot;
        } finally {
          timings.faq_load = now() - t;
        }
      })();

      // 片方が失敗したら残りの外部通信を中止する
      const guard = <T>(p: Promise<T>) =>
        p.catch((e) => {
          deadline.abort();
          throw e;
        });
      embeddingTask.catch(() => {});
      snapshotTask.catch(() => {});
      const [queryRaw, snapshot] = await Promise.all([guard(embeddingTask), guard(snapshotTask)]);

      Object.assign(logEntry, {
        cache: cacheStatus,
        fetched_count: snapshot.fetchedCount,
        valid_count: snapshot.validCount,
        invalid_count: snapshot.invalidCount,
        invalid_reasons: snapshot.invalidReasons,
      });

      const qv = validateVector(queryRaw, cfg.embedding.dimensions);
      if (!qv.ok) {
        return finish(errorResponse(requestId, "EMBEDDING_FAILED", { retryable: false }), {
          error_code: "EMBEDDING_FAILED",
          upstream_error: `embedding:invalid_vector:${qv.reason}`,
          timings_ms: timings,
        });
      }
      if (snapshot.validCount === 0) {
        return finish(errorResponse(requestId, "INDEX_NOT_READY"), { error_code: "INDEX_NOT_READY", timings_ms: timings });
      }

      const tSim = now();
      const outcome = rank(snapshot.entries, {
        queryUnit: toUnitFloat64(qv.vector, qv.norm),
        category: req.category,
        limit: req.limit,
        minSimilarity: cfg.minSimilarity,
        ambiguityMargin: cfg.ambiguityMargin,
      });
      timings.similarity = now() - tSim;
      const degraded = snapshot.invalidCount > 0;

      const response = {
        request_id: requestId,
        status: outcome.status,
        results: outcome.results.map(({ entry, score }) => ({
          id: entry.id,
          category: entry.category,
          question: entry.question,
          answer: entry.answer,
          score: round(score, 4),
        })),
        meta: {
          cache: cacheStatus,
          snapshot_at: new Date(snapshot.loadedAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
          embedding_spec: cfg.specId,
          degraded,
          reason: outcome.reason,
          timings_ms: { total: now() - started, ...timings },
        },
      };
      return finish(jsonResponse(200, response), {
        search_status: outcome.status,
        reason: outcome.reason,
        degraded,
        result_count: outcome.results.length,
        top_score: outcome.allScored[0] ? round(outcome.allScored[0].score, 4) : null,
        timings_ms: timings,
      });
    } catch (err) {
      const c = classifyError(err, deadlineHit);
      return finish(errorResponse(requestId, c.code, { retryable: c.retryable }), {
        error_code: c.code,
        upstream_error: c.upstream,
        cache: cacheStatus,
        timings_ms: timings,
      });
    } finally {
      clearTimeout(timer);
      deadline.abort();
    }
  }

  return {
    cache,
    async fetch(request: Request, env: Env): Promise<Response> {
      const started = now();
      const traceId = crypto.randomUUID();
      const url = new URL(request.url);
      try {
        if (url.pathname === "/healthz") {
          if (request.method !== "GET" && request.method !== "HEAD") {
            return errorResponse(traceId, "METHOD_NOT_ALLOWED", { headers: { Allow: "GET, HEAD" } });
          }
          return jsonResponse(200, { status: "ok" });
        }
        if (url.pathname === SEARCH_PATH) {
          if (request.method !== "POST") {
            return errorResponse(traceId, "METHOD_NOT_ALLOWED", { headers: { Allow: "POST" } });
          }
          return await handleSearch(request, env, traceId, started);
        }
        return errorResponse(traceId, "NOT_FOUND");
      } catch {
        log({ event: "faq_search", trace_id: traceId, http_status: errorStatus("INTERNAL_ERROR"), error_code: "INTERNAL_ERROR" });
        return errorResponse(traceId, "INTERNAL_ERROR");
      }
    },
  };
}
