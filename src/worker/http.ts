/** 応答ヘルパーとエラーコード定義（仕様 7.3）。 */

export type ErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "RATE_LIMITED"
  | "EMBEDDING_FAILED"
  | "KINTONE_FAILED"
  | "INDEX_NOT_READY"
  | "SNAPSHOT_TOO_LARGE"
  | "UPSTREAM_RATE_LIMITED"
  | "SEARCH_TIMEOUT"
  | "INTERNAL_ERROR";

const ERRORS: Record<ErrorCode, { status: number; message: string; retryable: boolean }> = {
  INVALID_REQUEST: { status: 400, message: "リクエストが不正です。", retryable: false },
  UNAUTHORIZED: { status: 401, message: "認証に失敗しました。", retryable: false },
  NOT_FOUND: { status: 404, message: "指定されたパスは存在しません。", retryable: false },
  METHOD_NOT_ALLOWED: { status: 405, message: "許可されていないメソッドです。", retryable: false },
  PAYLOAD_TOO_LARGE: { status: 413, message: "リクエストボディが上限を超えています。", retryable: false },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    message: "Content-Type は application/json を指定してください。",
    retryable: false,
  },
  RATE_LIMITED: { status: 429, message: "リクエストが多すぎます。時間をおいて再試行してください。", retryable: true },
  EMBEDDING_FAILED: { status: 502, message: "検索文のベクトル化に失敗しました。", retryable: true },
  KINTONE_FAILED: { status: 502, message: "FAQの取得に失敗しました。", retryable: true },
  INDEX_NOT_READY: { status: 503, message: "検索可能なFAQがありません。", retryable: false },
  SNAPSHOT_TOO_LARGE: { status: 503, message: "FAQデータが読み込み上限を超えています。", retryable: false },
  UPSTREAM_RATE_LIMITED: { status: 503, message: "上流サービスが混み合っています。", retryable: true },
  SEARCH_TIMEOUT: { status: 504, message: "FAQ検索が時間内に完了しませんでした。", retryable: true },
  INTERNAL_ERROR: { status: 500, message: "内部エラーが発生しました。", retryable: false },
};

const BASE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function errorStatus(code: ErrorCode): number {
  return ERRORS[code].status;
}

export function errorResponse(
  requestId: string,
  code: ErrorCode,
  opts: { message?: string; retryable?: boolean; headers?: Record<string, string> } = {},
): Response {
  const def = ERRORS[code];
  return jsonResponse(
    def.status,
    {
      request_id: requestId,
      error: {
        code,
        message: opts.message ?? def.message,
        retryable: opts.retryable ?? def.retryable,
      },
    },
    opts.headers,
  );
}
