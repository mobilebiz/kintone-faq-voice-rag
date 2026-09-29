/**
 * Embedding APIアダプター。初期実装は OpenAI Embeddings API（POST {baseUrl}/embeddings）。
 * 他プロバイダーを追加する場合はここへ分岐を足し、仕様ID（EMBEDDING_SPEC_ID）も変える。
 */
import { UpstreamError, isAbortError, kindFromStatus, parseRetryAfter } from "./errors.ts";

export interface EmbeddingConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
}

export interface EmbeddingCallOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export const SUPPORTED_EMBEDDING_PROVIDERS = ["openai"] as const;

/** 入力テキストごとのベクトル（数値配列）を返す。値の検証は呼び出し側で validateVector を使う。 */
export async function createEmbeddings(
  cfg: EmbeddingConfig,
  inputs: string[],
  opts: EmbeddingCallOptions = {},
): Promise<unknown[]> {
  if (cfg.provider !== "openai") {
    throw new Error(`unsupported embedding provider: ${cfg.provider}`);
  }
  if (inputs.length === 0) return [];
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${cfg.baseUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        input: inputs,
        dimensions: cfg.dimensions,
        encoding_format: "float",
      }),
      signal: opts.signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw new UpstreamError("embedding", "timeout", "embedding request aborted");
    throw new UpstreamError("embedding", "network", "embedding request failed");
  }

  if (!res.ok) {
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: { code?: unknown; type?: unknown } };
      const c = body?.error?.code ?? body?.error?.type;
      if (typeof c === "string") code = c;
    } catch {
      // 本文が JSON でない場合は無視
    }
    throw new UpstreamError(
      "embedding",
      kindFromStatus(res.status),
      `embedding API returned HTTP ${res.status}`,
      res.status,
      code,
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    if (isAbortError(err)) throw new UpstreamError("embedding", "timeout", "embedding response aborted");
    throw new UpstreamError("embedding", "bad_response", "embedding response is not JSON");
  }
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data) || data.length !== inputs.length) {
    throw new UpstreamError("embedding", "bad_response", "embedding response has unexpected shape");
  }
  const out: unknown[] = new Array(inputs.length);
  for (const item of data) {
    const idx = (item as { index?: unknown })?.index;
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= inputs.length || out[idx] !== undefined) {
      throw new UpstreamError("embedding", "bad_response", "embedding response has invalid index");
    }
    out[idx] = (item as { embedding?: unknown }).embedding;
  }
  return out;
}

export async function createEmbedding(
  cfg: EmbeddingConfig,
  input: string,
  opts: EmbeddingCallOptions = {},
): Promise<unknown> {
  const [vec] = await createEmbeddings(cfg, [input], opts);
  return vec;
}
