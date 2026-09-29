/**
 * kintone REST API クライアント（必要最小限）。
 * - 取得は `$id` 昇順の継続取得でページングし、件数上限で黙って打ち切らない（仕様 9.2）。
 * - 更新は revision 指定の1件更新（仕様 6.2）。
 */
import { UpstreamError, isAbortError, kindFromStatus, parseRetryAfter } from "./errors.ts";

export interface KintoneConfig {
  baseUrl: string;
  appId: string;
  guestSpaceId?: string;
  apiToken: string;
}

export interface KintoneFieldValue {
  type?: string;
  value: unknown;
}
export type KintoneRecord = Record<string, KintoneFieldValue>;

export interface KintoneCallOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export const KINTONE_PAGE_SIZE = 500;

export class SnapshotTooLargeError extends Error {
  constructor(readonly bytes: number, readonly limit: number) {
    super(`kintone response exceeds ${limit} bytes`);
    this.name = "SnapshotTooLargeError";
  }
}

export function kintoneApiUrl(cfg: KintoneConfig, path: string): string {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const prefix = cfg.guestSpaceId ? `/k/guest/${cfg.guestSpaceId}/v1/` : "/k/v1/";
  return `${base}${prefix}${path}`;
}

async function kintoneRequest(
  cfg: KintoneConfig,
  method: "GET" | "PUT",
  path: string,
  opts: KintoneCallOptions & { query?: URLSearchParams; body?: unknown; maxBytes?: number },
): Promise<{ json: unknown; bytes: number }> {
  const doFetch = opts.fetch ?? fetch;
  const url = kintoneApiUrl(cfg, path) + (opts.query ? `?${opts.query.toString()}` : "");
  const headers: Record<string, string> = { "X-Cybozu-API-Token": cfg.apiToken };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await doFetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw new UpstreamError("kintone", "timeout", "kintone request aborted");
    throw new UpstreamError("kintone", "network", "kintone request failed");
  }

  if (opts.maxBytes !== undefined) {
    const len = Number(res.headers.get("content-length"));
    if (Number.isFinite(len) && len > opts.maxBytes) {
      await res.body?.cancel();
      throw new SnapshotTooLargeError(len, opts.maxBytes);
    }
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    if (isAbortError(err)) throw new UpstreamError("kintone", "timeout", "kintone response aborted");
    throw new UpstreamError("kintone", "network", "kintone response read failed");
  }
  const bytes = new TextEncoder().encode(text).byteLength;
  if (opts.maxBytes !== undefined && bytes > opts.maxBytes) {
    throw new SnapshotTooLargeError(bytes, opts.maxBytes);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }

  if (!res.ok) {
    const code = typeof (json as { code?: unknown })?.code === "string" ? (json as { code: string }).code : undefined;
    // revision 不一致は GAIA_CO02（HTTP 409）。コードでも判定する。
    const kind = code === "GAIA_CO02" ? "conflict" : kindFromStatus(res.status);
    const detail = (json as { message?: unknown })?.message;
    throw new UpstreamError(
      "kintone",
      kind,
      `kintone API returned HTTP ${res.status}${code ? ` (${code})` : ""}${typeof detail === "string" ? `: ${detail.slice(0, 200)}` : ""}`,
      res.status,
      code,
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }
  if (json === undefined) throw new UpstreamError("kintone", "bad_response", "kintone response is not JSON");
  return { json, bytes };
}

export interface FetchAllOptions extends KintoneCallOptions {
  /** 追加条件（呼び出し側で検証済みの固定値のみ。利用者入力を埋め込まない）。 */
  condition?: string;
  /** 取得した応答本文の累計バイト上限。 */
  maxBytes?: number;
}

/** `$id` 昇順の継続取得で全件を取得する。 */
export async function fetchAllRecords(
  cfg: KintoneConfig,
  fields: string[],
  opts: FetchAllOptions = {},
): Promise<{ records: KintoneRecord[]; bytes: number; requests: number }> {
  const all: KintoneRecord[] = [];
  let lastId = 0;
  let totalBytes = 0;
  let requests = 0;
  const fieldSet = Array.from(new Set(["$id", ...fields]));

  for (;;) {
    const cond = [`$id > ${lastId}`];
    if (opts.condition) cond.push(`(${opts.condition})`);
    const query = new URLSearchParams();
    query.set("app", cfg.appId);
    query.set("query", `${cond.join(" and ")} order by $id asc limit ${KINTONE_PAGE_SIZE}`);
    fieldSet.forEach((f, i) => query.set(`fields[${i}]`, f));

    const remaining = opts.maxBytes !== undefined ? opts.maxBytes - totalBytes : undefined;
    const { json, bytes } = await kintoneRequest(cfg, "GET", "records.json", {
      ...opts,
      query,
      maxBytes: remaining,
    });
    requests++;
    totalBytes += bytes;

    const records = (json as { records?: unknown }).records;
    if (!Array.isArray(records)) {
      throw new UpstreamError("kintone", "bad_response", "kintone records response has unexpected shape");
    }
    for (const r of records as KintoneRecord[]) {
      const id = Number(r?.["$id"]?.value);
      if (!Number.isInteger(id) || id <= lastId) {
        throw new UpstreamError("kintone", "bad_response", "kintone record id is invalid or not ascending");
      }
      lastId = id;
      all.push(r);
    }
    if (records.length < KINTONE_PAGE_SIZE) break;
  }
  return { records: all, bytes: totalBytes, requests };
}

/** revision を指定して1件更新する。競合時は UpstreamError(kind="conflict")。 */
export async function updateRecord(
  cfg: KintoneConfig,
  id: string,
  revision: string,
  record: Record<string, { value: unknown }>,
  opts: KintoneCallOptions = {},
): Promise<string> {
  const { json } = await kintoneRequest(cfg, "PUT", "record.json", {
    ...opts,
    body: { app: cfg.appId, id, revision, record },
  });
  const rev = (json as { revision?: unknown }).revision;
  if (typeof rev !== "string" && typeof rev !== "number") {
    throw new UpstreamError("kintone", "bad_response", "kintone update response has no revision");
  }
  return String(rev);
}

export function fieldString(record: KintoneRecord, code: string): string {
  const v = record[code]?.value;
  if (v == null) return "";
  return typeof v === "string" ? v : String(v);
}
