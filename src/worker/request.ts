/** 検索リクエストの読み取り・検証（仕様 7.1）。 */
import { codePointLength, normalizeField, normalizeQuery } from "../shared/text.ts";

export const MAX_BODY_BYTES = 16 * 1024;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ALLOWED_KEYS = new Set(["query", "category", "limit", "request_id"]);

export interface SearchRequest {
  query: string;
  category?: string;
  limit: number;
  requestId?: string;
}

export type ValidationResult =
  | { ok: true; value: SearchRequest }
  | { ok: false; message: string; requestId?: string };

/** Content-Type が application/json か（charset 等のパラメーターは許容）。 */
export function isJsonContentType(header: string | null): boolean {
  if (!header) return false;
  return header.split(";")[0]!.trim().toLowerCase() === "application/json";
}

/**
 * 上限付きでボディを読む。上限超過なら null。
 * signal が中断されたら読み取りを中止して TimeoutError を投げる（全体期限）。
 */
export async function readBodyLimited(req: Request, limit: number, signal?: AbortSignal): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await req.body?.cancel();
    return null;
  }
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const timeoutError = () => new DOMException("request body read timed out", "TimeoutError");
  if (signal?.aborted) {
    await reader.cancel().catch(() => {});
    throw timeoutError();
  }
  let rejectAborted: (err: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = reject;
  });
  aborted.catch(() => {}); // 読み取り完了後に期限が来ても未処理の reject にしない
  const onAbort = () => {
    rejectAborted(timeoutError());
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export function validateSearchBody(body: unknown, defaultLimit: number, maxLimit: number): ValidationResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "リクエストボディはJSONオブジェクトで指定してください。" };
  }
  const obj = body as Record<string, unknown>;

  // request_id は他の検証エラー時にも応答へ使えるよう先に確認する。
  let requestId: string | undefined;
  if (obj.request_id !== undefined && obj.request_id !== null) {
    if (typeof obj.request_id !== "string" || !REQUEST_ID_RE.test(obj.request_id)) {
      return { ok: false, message: "request_id は英数字・ハイフン・アンダースコア1〜64文字で指定してください。" };
    }
    requestId = obj.request_id;
  }
  const fail = (message: string): ValidationResult => ({ ok: false, message, requestId });

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) return fail(`未知のフィールドがあります: ${key.slice(0, 40)}`);
  }

  if (typeof obj.query !== "string") return fail("query は必須の文字列です。");
  const query = normalizeQuery(obj.query);
  const qLen = codePointLength(query);
  if (qLen < 1 || qLen > 1000) return fail("query は1〜1,000文字で指定してください。");

  let category: string | undefined;
  if (obj.category !== undefined && obj.category !== null) {
    if (typeof obj.category !== "string") return fail("category は文字列で指定してください。");
    category = normalizeField(obj.category);
    const cLen = codePointLength(category);
    if (cLen < 1 || cLen > 100) return fail("category は1〜100文字で指定してください。");
  }

  let limit = defaultLimit;
  if (obj.limit !== undefined && obj.limit !== null) {
    if (typeof obj.limit !== "number" || !Number.isInteger(obj.limit) || obj.limit < 1 || obj.limit > maxLimit) {
      return fail(`limit は1〜${maxLimit}の整数で指定してください。`);
    }
    limit = obj.limit;
  }

  return { ok: true, value: { query, category, limit, requestId } };
}
