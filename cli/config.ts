/** 管理CLI・スクリプト用の設定（環境変数のみから読む。キーを引数で受け取らない）。 */
import { SUPPORTED_EMBEDDING_PROVIDERS, type EmbeddingConfig } from "../src/shared/embedding.ts";
import { fieldCodesFromEnv, type FieldCodes } from "../src/shared/fields.ts";
import type { KintoneConfig } from "../src/shared/kintone.ts";

export interface CliConfig {
  kintone: KintoneConfig;
  embedding: EmbeddingConfig;
  fields: FieldCodes;
  specId: string;
  maxInputChars: number;
}

export class CliConfigError extends Error {}

type EnvLike = Record<string, string | undefined>;

function req(env: EnvLike, name: string, problems: string[]): string {
  const v = env[name]?.trim();
  if (!v) problems.push(`${name} が未設定です`);
  return v ?? "";
}

/**
 * @param tokenVar 使用する kintone トークンの環境変数名（索引は書き込み用、評価は閲覧用でも可）
 */
export function loadCliConfig(
  env: EnvLike = process.env,
  tokenVar: string | string[] = "KINTONE_WRITE_API_TOKEN",
  opts: { requireEmbeddingKey?: boolean } = {},
): CliConfig {
  const problems: string[] = [];
  const tokenVars = Array.isArray(tokenVar) ? tokenVar : [tokenVar];
  const token = tokenVars.map((n) => env[n]?.trim()).find((v) => v);
  if (!token) problems.push(`${tokenVars.join(" または ")} が未設定です`);

  const baseUrl = req(env, "KINTONE_BASE_URL", problems);
  const appId = req(env, "KINTONE_APP_ID", problems);
  if (appId && !/^\d+$/.test(appId)) problems.push("KINTONE_APP_ID が数値ではありません");
  const guest = env.KINTONE_GUEST_SPACE_ID?.trim() || undefined;
  if (guest && !/^\d+$/.test(guest)) problems.push("KINTONE_GUEST_SPACE_ID が数値ではありません");

  const provider = req(env, "EMBEDDING_PROVIDER", problems);
  if (provider && !(SUPPORTED_EMBEDDING_PROVIDERS as readonly string[]).includes(provider)) {
    problems.push(`EMBEDDING_PROVIDER=${provider} は未対応です`);
  }
  const model = req(env, "EMBEDDING_MODEL", problems);
  const dimensions = Number(req(env, "EMBEDDING_DIMENSIONS", problems));
  if (!Number.isInteger(dimensions) || dimensions <= 0) problems.push("EMBEDDING_DIMENSIONS が不正です");
  const specId = req(env, "EMBEDDING_SPEC_ID", problems);
  const apiKey = opts.requireEmbeddingKey === false ? env.EMBEDDING_API_KEY?.trim() ?? "" : req(env, "EMBEDDING_API_KEY", problems);
  const maxInputChars = Number(env.EMBEDDING_MAX_INPUT_CHARS?.trim() || "6000");
  if (!Number.isInteger(maxInputChars) || maxInputChars <= 0) problems.push("EMBEDDING_MAX_INPUT_CHARS が不正です");

  if (problems.length > 0) throw new CliConfigError(problems.join("\n"));
  return {
    kintone: { baseUrl, appId, guestSpaceId: guest, apiToken: token! },
    embedding: {
      provider,
      baseUrl: env.EMBEDDING_BASE_URL?.trim() || "https://api.openai.com/v1",
      apiKey,
      model,
      dimensions,
    },
    fields: fieldCodesFromEnv(env),
    specId,
    maxInputChars,
  };
}
