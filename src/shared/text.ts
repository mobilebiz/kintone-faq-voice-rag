/**
 * ベクトル化する文章の正規化・テンプレート・ハッシュ（仕様 5.1）。
 * 管理CLIと検索APIで必ずこのモジュールを共有する。
 */

export const TEMPLATE_ID = "faq-v1";

export interface FaqContent {
  category: string;
  question: string;
  answer: string;
}

/** Unicode NFC、改行をLFへ統一、前後の空白を除去。内部の改行・空白・記号は保持する。 */
export function normalizeField(value: string | null | undefined): string {
  if (value == null) return "";
  return value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
}

/** テンプレート faq-v1 の完成テキスト。 */
export function buildEmbeddingText(content: FaqContent): string {
  return [
    `カテゴリ：${normalizeField(content.category)}`,
    `質問：${normalizeField(content.question)}`,
    `回答：${normalizeField(content.answer)}`,
  ].join("\n");
}

/** 検索文も同じ正規化をかける（テンプレートは適用しない）。 */
export function normalizeQuery(query: string): string {
  return normalizeField(query);
}

/** UTF-8バイト列のSHA-256、16進小文字。 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Unicodeコードポイント数。 */
export function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}
