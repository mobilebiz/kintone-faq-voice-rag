/**
 * Workers の環境変数・Secrets を検証済み設定へ変換する（仕様 13章）。
 * しきい値（MIN_SIMILARITY / AMBIGUITY_MARGIN）は既定値を持たず必須。
 */
import type { EmbeddingConfig } from "../shared/embedding.ts";
import { SUPPORTED_EMBEDDING_PROVIDERS } from "../shared/embedding.ts";
import { fieldCodesFromEnv, type FieldCodes } from "../shared/fields.ts";
import type { KintoneConfig } from "../shared/kintone.ts";

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  // Secrets
  FAQ_SEARCH_API_KEY?: string;
  KINTONE_READ_API_TOKEN?: string;
  EMBEDDING_API_KEY?: string;
  // Vars
  KINTONE_BASE_URL?: string;
  KINTONE_APP_ID?: string;
  KINTONE_GUEST_SPACE_ID?: string;
  EMBEDDING_PROVIDER?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_DIMENSIONS?: string;
  EMBEDDING_SPEC_ID?: string;
  EMBEDDING_BASE_URL?: string;
  CACHE_TTL_SECONDS?: string;
  DEFAULT_LIMIT?: string;
  MAX_LIMIT?: string;
  MIN_SIMILARITY?: string;
  AMBIGUITY_MARGIN?: string;
  SEARCH_TIMEOUT_MS?: string;
  UPSTREAM_TIMEOUT_MS?: string;
  EMBEDDING_HEDGE_MS?: string;
  MAX_SNAPSHOT_BYTES?: string;
  RATE_LIMIT_RETRY_AFTER_SECONDS?: string;
  // Bindings
  SEARCH_RATE_LIMITER?: RateLimiter;
  [key: string]: unknown;
}

export interface WorkerConfig {
  apiKey: string;
  kintone: KintoneConfig;
  embedding: EmbeddingConfig;
  fields: FieldCodes;
  specId: string;
  cacheTtlMs: number;
  defaultLimit: number;
  maxLimit: number;
  minSimilarity: number;
  ambiguityMargin: number;
  searchTimeoutMs: number;
  upstreamTimeoutMs: number;
  /** 検索文 Embedding のヘッジ開始までの待ち時間。0 でヘッジしない */
  embeddingHedgeMs: number;
  maxSnapshotBytes: number;
  rateLimitRetryAfterSeconds: number;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration: ${problems.join(", ")}`);
    this.name = "ConfigError";
  }
}

const HARD_MAX_LIMIT = 5;
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export function loadConfig(env: Env): WorkerConfig {
  const problems: string[] = [];

  const str = (name: keyof Env, required = true): string => {
    const v = env[name];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (required) problems.push(`${String(name)} is required`);
    return "";
  };
  const num = (
    name: keyof Env,
    def: number | undefined,
    check: (n: number) => boolean,
  ): number => {
    const raw = env[name];
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
      if (def === undefined) problems.push(`${String(name)} is required`);
      return def ?? NaN;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || !check(n)) {
      problems.push(`${String(name)} is invalid`);
      return NaN;
    }
    return n;
  };
  const posInt = (n: number) => Number.isInteger(n) && n > 0;

  const baseUrl = str("KINTONE_BASE_URL");
  if (baseUrl && !/^https?:\/\/[^/]+/.test(baseUrl)) problems.push("KINTONE_BASE_URL is invalid");
  const appId = str("KINTONE_APP_ID");
  if (appId && !/^\d+$/.test(appId)) problems.push("KINTONE_APP_ID is invalid");
  const guest = str("KINTONE_GUEST_SPACE_ID", false);
  if (guest && !/^\d+$/.test(guest)) problems.push("KINTONE_GUEST_SPACE_ID is invalid");

  const provider = str("EMBEDDING_PROVIDER");
  if (provider && !(SUPPORTED_EMBEDDING_PROVIDERS as readonly string[]).includes(provider)) {
    problems.push("EMBEDDING_PROVIDER is unsupported");
  }
  const embeddingBase = str("EMBEDDING_BASE_URL", false) || DEFAULT_OPENAI_BASE_URL;
  if (!/^https?:\/\/[^/]+/.test(embeddingBase)) problems.push("EMBEDDING_BASE_URL is invalid");

  const dimensions = num("EMBEDDING_DIMENSIONS", undefined, posInt);
  const maxLimit = num("MAX_LIMIT", HARD_MAX_LIMIT, (n) => posInt(n) && n <= HARD_MAX_LIMIT);
  const defaultLimit = num("DEFAULT_LIMIT", 3, posInt);
  if (Number.isFinite(defaultLimit) && Number.isFinite(maxLimit) && defaultLimit > maxLimit) {
    problems.push("DEFAULT_LIMIT must be <= MAX_LIMIT");
  }
  const searchTimeoutMs = num("SEARCH_TIMEOUT_MS", 2500, posInt);
  const upstreamTimeoutMs = num("UPSTREAM_TIMEOUT_MS", 2000, posInt);
  const embeddingHedgeMs = num("EMBEDDING_HEDGE_MS", 0, (n) => Number.isInteger(n) && n >= 0);

  const cfg: WorkerConfig = {
    apiKey: str("FAQ_SEARCH_API_KEY"),
    kintone: {
      baseUrl,
      appId,
      guestSpaceId: guest || undefined,
      apiToken: str("KINTONE_READ_API_TOKEN"),
    },
    embedding: {
      provider,
      baseUrl: embeddingBase,
      apiKey: str("EMBEDDING_API_KEY"),
      model: str("EMBEDDING_MODEL"),
      dimensions,
    },
    fields: fieldCodesFromEnv(env),
    specId: str("EMBEDDING_SPEC_ID"),
    cacheTtlMs: num("CACHE_TTL_SECONDS", 60, (n) => n >= 0) * 1000,
    defaultLimit,
    maxLimit,
    minSimilarity: num("MIN_SIMILARITY", undefined, (n) => n >= -1 && n <= 1),
    ambiguityMargin: num("AMBIGUITY_MARGIN", undefined, (n) => n >= 0 && n <= 2),
    searchTimeoutMs,
    upstreamTimeoutMs,
    embeddingHedgeMs,
    maxSnapshotBytes: num("MAX_SNAPSHOT_BYTES", 10 * 1024 * 1024, posInt),
    rateLimitRetryAfterSeconds: num("RATE_LIMIT_RETRY_AFTER_SECONDS", 60, posInt),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return cfg;
}

/** キャッシュ内容が依存する設定の識別子。設定が変わった isolate では旧スナップショットを使わない。 */
export function snapshotKey(cfg: WorkerConfig): string {
  return JSON.stringify([
    cfg.kintone.baseUrl,
    cfg.kintone.appId,
    cfg.kintone.guestSpaceId ?? "",
    cfg.specId,
    cfg.embedding.dimensions,
    cfg.fields,
    cfg.maxSnapshotBytes,
  ]);
}
