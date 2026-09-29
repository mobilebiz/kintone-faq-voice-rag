import type { CliConfig } from "../../cli/config.ts";
import { loadCliConfig } from "../../cli/config.ts";
import type { Env } from "../../src/worker/config.ts";

export const DIMS = 256;
export const SPEC_ID = `openai/mock-hash-embedding/${DIMS}/faq-v1`;
export const API_KEY = "test-search-key";

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    FAQ_SEARCH_API_KEY: API_KEY,
    KINTONE_READ_API_TOKEN: "mock-token",
    EMBEDDING_API_KEY: "mock-key",
    KINTONE_BASE_URL: "https://mock.cybozu.test",
    KINTONE_APP_ID: "146",
    EMBEDDING_PROVIDER: "openai",
    EMBEDDING_MODEL: "mock-hash-embedding",
    EMBEDDING_DIMENSIONS: String(DIMS),
    EMBEDDING_SPEC_ID: SPEC_ID,
    EMBEDDING_BASE_URL: "https://mock.openai.test/v1",
    MIN_SIMILARITY: "0.2",
    AMBIGUITY_MARGIN: "0.02",
    CACHE_TTL_SECONDS: "60",
    SEARCH_TIMEOUT_MS: "2500",
    UPSTREAM_TIMEOUT_MS: "2000",
    ...overrides,
  };
}

export function testCliConfig(overrides: Record<string, string> = {}): CliConfig {
  return loadCliConfig({
    KINTONE_BASE_URL: "https://mock.cybozu.test",
    KINTONE_APP_ID: "146",
    KINTONE_WRITE_API_TOKEN: "mock-token",
    EMBEDDING_PROVIDER: "openai",
    EMBEDDING_MODEL: "mock-hash-embedding",
    EMBEDDING_DIMENSIONS: String(DIMS),
    EMBEDDING_SPEC_ID: SPEC_ID,
    EMBEDDING_API_KEY: "mock-key",
    EMBEDDING_BASE_URL: "https://mock.openai.test/v1",
    ...overrides,
  });
}

export function searchRequest(body: unknown, init: { key?: string | null; contentType?: string; raw?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": init.contentType ?? "application/json" };
  const key = init.key === undefined ? API_KEY : init.key;
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  return new Request("https://faq.example.test/v1/faq/search", {
    method: "POST",
    headers,
    body: init.raw ?? JSON.stringify(body),
  });
}
