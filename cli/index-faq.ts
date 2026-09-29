/**
 * npm run index:faq [-- --dry-run] [-- --id 42] [-- --force] [-- --concurrency 2]
 * --force は全対象の Embedding を再生成するため API 課金が発生する。
 */
import { parseArgs } from "node:util";
import { CliConfigError, loadCliConfig } from "./config.ts";
import { exitCodeFor, formatReport, runIndex } from "./indexer.ts";

const USAGE = `使い方:
  npm run index:faq -- [--dry-run] [--force] [--id <recordId> ...] [--concurrency <n>]

  --dry-run       変更対象と検証エラーのみ表示（Embedding呼び出し・書き込みなし）
  --force         全対象を再生成（Embedding API の課金が発生します）
  --id <id>       指定レコードだけ処理（複数指定・カンマ区切り可）
  --concurrency   並列度（既定 2）
`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      id: { type: "string", multiple: true },
      concurrency: { type: "string", default: "2" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    console.error("--concurrency は 1〜8 の整数で指定してください");
    return 2;
  }
  const ids = values.id?.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  if (ids?.some((id) => !/^\d+$/.test(id))) {
    console.error("--id はレコードID（数値）で指定してください");
    return 2;
  }

  let cfg;
  try {
    cfg = loadCliConfig(process.env, "KINTONE_WRITE_API_TOKEN", { requireEmbeddingKey: !values["dry-run"] });
  } catch (err) {
    if (err instanceof CliConfigError) {
      console.error(`設定エラー:\n${err.message}`);
      return 2;
    }
    throw err;
  }

  if (values.force && !values["dry-run"]) {
    console.log("--force: 対象レコードすべての Embedding を再生成します（API課金が発生します）");
  }
  const report = await runIndex(cfg, {
    dryRun: values["dry-run"],
    force: values.force,
    ids,
    concurrency,
  });
  console.log(formatReport(report));
  return exitCodeFor(report);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`失敗: ${err instanceof Error ? `${err.name}: ${err.message}` : "unknown"}`);
    process.exit(1);
  },
);
