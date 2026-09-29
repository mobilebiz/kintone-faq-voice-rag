/** 上流API（kintone / Embedding）のエラー分類。 */

export type UpstreamService = "kintone" | "embedding";

export type UpstreamErrorKind =
  | "auth" // 401/403: 上流の認証・権限。呼び出し元の401には変換しない
  | "rate_limited" // 429
  | "timeout" // 期限超過・中断
  | "client" // 4xx（入力上限超過など）
  | "server" // 5xx
  | "network" // 接続失敗
  | "bad_response" // 想定外の応答形式
  | "conflict"; // kintone revision 競合

export class UpstreamError extends Error {
  constructor(
    readonly service: UpstreamService,
    readonly kind: UpstreamErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export function kindFromStatus(status: number): UpstreamErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 409) return "conflict";
  if (status >= 500) return "server";
  return "client";
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  );
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const n = Number(header);
  if (Number.isFinite(n) && n >= 0) return n;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return undefined;
}
