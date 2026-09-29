/** Bearer APIキーの検証。固定長ダイジェスト同士を定数時間比較し、キー本体はログに出さない。 */

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

type SubtleWithTimingSafe = typeof crypto.subtle & {
  timingSafeEqual?: (a: ArrayBufferView | ArrayBuffer, b: ArrayBufferView | ArrayBuffer) => boolean;
};

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const subtle = crypto.subtle as SubtleWithTimingSafe;
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function extractBearer(header: string | null): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer[ ]+([^\s]+)\s*$/i.exec(header);
  return m?.[1];
}

export async function verifyApiKey(header: string | null, expected: string): Promise<boolean> {
  const token = extractBearer(header);
  if (!token || !expected) return false;
  const [a, b] = await Promise.all([digest(token), digest(expected)]);
  return constantTimeEqual(a, b);
}
