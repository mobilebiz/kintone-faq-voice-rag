/**
 * kintone REST API と OpenAI Embeddings API の最小モック（Fetch API の Request→Response）。
 * ローカル動作確認（scripts/mock-upstream.ts）とテストで共用する。
 */
import { DEFAULT_FIELD_CODES, type FieldCodes } from "../src/shared/fields.ts";
import { buildEmbeddingText, sha256Hex } from "../src/shared/text.ts";
import { mockEmbedding } from "./mock-embedding.ts";
import type { SampleFaq } from "./sample-faq.ts";

export interface MockRecord {
  revision: number;
  values: Record<string, string>;
}

export interface MockFaults {
  kintoneStatus?: number;
  kintoneBody?: unknown;
  kintoneDelayMs?: number;
  embeddingStatus?: number;
  embeddingDelayMs?: number;
  /** Embedding 呼び出しごとの遅延（先頭から1件ずつ消費。尽きたら embeddingDelayMs） */
  embeddingDelaysMs?: number[];
  /** Embedding応答を差し替える（不正ベクトル検証用） */
  embeddingOverride?: unknown;
  /** 指定IDの次回PUTでrevision競合を返す回数 */
  conflicts?: Map<string, number>;
}

export interface MockOptions {
  kintoneToken?: string;
  embeddingKey?: string;
  defaultDimensions?: number;
  fields?: FieldCodes;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export class MockUpstream {
  records = new Map<number, MockRecord>();
  faults: MockFaults = {};
  counts = { kintoneGet: 0, kintonePut: 0, embedding: 0, embeddingInputs: 0 };
  readonly fields: FieldCodes;
  private readonly kintoneToken: string;
  private readonly embeddingKey: string;
  private readonly defaultDimensions: number;

  constructor(opts: MockOptions = {}) {
    this.fields = opts.fields ?? DEFAULT_FIELD_CODES;
    this.kintoneToken = opts.kintoneToken ?? "mock-token";
    this.embeddingKey = opts.embeddingKey ?? "mock-key";
    this.defaultDimensions = opts.defaultDimensions ?? 256;
  }

  addFaq(faqs: SampleFaq[]): void {
    for (const f of faqs) {
      this.records.set(f.id, {
        revision: 1,
        values: {
          [this.fields.category]: f.category,
          [this.fields.question]: f.question,
          [this.fields.answer]: f.answer,
          [this.fields.embedding]: "",
          [this.fields.embeddingSpec]: "",
          [this.fields.embeddingHash]: "",
          [this.fields.embeddedAt]: "",
        },
      });
    }
  }

  /** 管理CLIを経由せずにモック内で索引済み状態にする。 */
  async preindex(specId: string, dimensions: number): Promise<void> {
    for (const rec of this.records.values()) {
      const text = buildEmbeddingText({
        category: rec.values[this.fields.category] ?? "",
        question: rec.values[this.fields.question] ?? "",
        answer: rec.values[this.fields.answer] ?? "",
      });
      rec.values[this.fields.embedding] = JSON.stringify(mockEmbedding(text, dimensions));
      rec.values[this.fields.embeddingSpec] = specId;
      rec.values[this.fields.embeddingHash] = await sha256Hex(text);
      rec.values[this.fields.embeddedAt] = "2026-09-29T00:00:00Z";
      rec.revision++;
    }
  }

  /** 利用者がkintone画面で編集した想定（revisionが進む）。 */
  editField(id: number, field: string, value: string): void {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`no record ${id}`);
    rec.values[field] = value;
    rec.revision++;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    return this.handle(req);
  };

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const kintoneMatch = /^\/k\/(?:guest\/\d+\/)?v1\/(records?\.json)$/.exec(url.pathname);
    if (kintoneMatch) return this.handleKintone(req, url, kintoneMatch[1]!);
    if (url.pathname.endsWith("/embeddings") && req.method === "POST") return this.handleEmbedding(req);
    return json(404, { message: "not found" });
  }

  private async handleKintone(req: Request, url: URL, path: string): Promise<Response> {
    if (this.faults.kintoneDelayMs) await delay(this.faults.kintoneDelayMs, req.signal);
    if (req.headers.get("x-cybozu-api-token") !== this.kintoneToken) {
      return json(401, { code: "GAIA_IA02", message: "APIトークンが不正です。" });
    }
    if (this.faults.kintoneStatus) {
      return json(this.faults.kintoneStatus, this.faults.kintoneBody ?? { code: "MOCK_ERROR", message: "mock error" });
    }

    if (req.method === "GET" && path === "records.json") {
      this.counts.kintoneGet++;
      const query = url.searchParams.get("query") ?? "";
      const fields: string[] = [];
      for (const [k, v] of url.searchParams) if (/^fields\[\d+\]$/.test(k)) fields.push(v);
      const gt = Number(/\$id > (\d+)/.exec(query)?.[1] ?? "0");
      const eq = /\$id = (\d+)/.exec(query)?.[1];
      const inList = /\$id in \(([\d,\s]+)\)/.exec(query)?.[1]?.split(",").map((s) => Number(s.trim()));
      const limit = Math.min(500, Number(/limit (\d+)/.exec(query)?.[1] ?? "100"));
      const ids = [...this.records.keys()]
        .filter((id) => id > gt)
        .filter((id) => (eq ? id === Number(eq) : true))
        .filter((id) => (inList ? inList.includes(id) : true))
        .sort((a, b) => a - b)
        .slice(0, limit);
      const records = ids.map((id) => {
        const rec = this.records.get(id)!;
        const out: Record<string, { type: string; value: string }> = {};
        const want = fields.length > 0 ? fields : ["$id", "$revision", ...Object.keys(rec.values)];
        for (const f of want) {
          if (f === "$id") out[f] = { type: "__ID__", value: String(id) };
          else if (f === "$revision") out[f] = { type: "__REVISION__", value: String(rec.revision) };
          else if (f in rec.values) out[f] = { type: "SINGLE_LINE_TEXT", value: rec.values[f]! };
        }
        return out;
      });
      return json(200, { records, totalCount: null });
    }

    if (req.method === "PUT" && path === "record.json") {
      this.counts.kintonePut++;
      const body = (await req.json()) as { id: string; revision: string; record: Record<string, { value: string }> };
      const id = Number(body.id);
      const rec = this.records.get(id);
      if (!rec) return json(404, { code: "GAIA_RE01", message: "指定したレコードが見つかりません。" });
      const forced = this.faults.conflicts?.get(String(id)) ?? 0;
      if (forced > 0) {
        this.faults.conflicts!.set(String(id), forced - 1);
        rec.revision++; // 他者の更新が入った想定
      }
      if (body.revision !== undefined && String(body.revision) !== "-1" && Number(body.revision) !== rec.revision) {
        return json(409, { code: "GAIA_CO02", message: "指定したリビジョンは最新ではありません。" });
      }
      for (const [k, v] of Object.entries(body.record)) rec.values[k] = v.value;
      rec.revision++;
      return json(200, { revision: String(rec.revision) });
    }
    return json(405, { message: "method not allowed" });
  }

  private async handleEmbedding(req: Request): Promise<Response> {
    const delayMs = this.faults.embeddingDelaysMs?.shift() ?? this.faults.embeddingDelayMs;
    if (delayMs) await delay(delayMs, req.signal);
    if (req.headers.get("authorization") !== `Bearer ${this.embeddingKey}`) {
      return json(401, { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } });
    }
    if (this.faults.embeddingStatus) {
      return json(
        this.faults.embeddingStatus,
        { error: { message: "mock error", type: "mock", code: "mock_error" } },
        this.faults.embeddingStatus === 429 ? { "Retry-After": "0" } : {},
      );
    }
    const body = (await req.json()) as { input: string | string[]; dimensions?: number };
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    this.counts.embedding++;
    this.counts.embeddingInputs += inputs.length;
    const dims = body.dimensions ?? this.defaultDimensions;
    const data = inputs.map((text, index) => ({
      object: "embedding",
      index,
      embedding: this.faults.embeddingOverride ?? mockEmbedding(text, dims),
    }));
    return json(200, { object: "list", data, model: "mock", usage: { prompt_tokens: 0, total_tokens: 0 } });
  }
}
