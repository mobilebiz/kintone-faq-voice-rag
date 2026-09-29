/**
 * 検索品質評価としきい値調整（仕様 8章・14.2）。
 *
 *   # オフライン評価：kintoneの実ベクトルと本番と同じ検索コードで、任意のしきい値を試す
 *   npm run eval:search -- --set eval/eval-set.local.json --sweep
 *   npm run eval:search -- --set eval/eval-set.local.json --min 0.42 --margin 0.02 [--split eval|tune|all]
 *   # API評価：デプロイ済み検索APIを実際に呼ぶ（APIに設定されたしきい値で評価）
 *   npm run eval:search -- --set eval/eval-set.local.json --api
 *
 * 評価セット（JSON配列）:
 *   { "id": "p01", "split": "tune" | "eval", "type": "paraphrase" | "ambiguous" | "out_of_scope",
 *     "query": "...", "category": "任意", "expected_ids": ["42"], "expected_status": "matched" | "ambiguous" | "no_match" }
 * --sweep は split=tune で候補を選び、split=eval で最終値を報告する（調整用と評価用を分ける）。
 * Embedding API の料金が質問数ぶん発生する（オフライン評価は1回のバッチ呼び出しで全質問をベクトル化）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadCliConfig } from "../cli/config.ts";
import { createEmbeddings } from "../src/shared/embedding.ts";
import { fetchAllRecords } from "../src/shared/kintone.ts";
import { rank, type SearchStatus } from "../src/shared/search.ts";
import { buildSnapshot, type FaqEntry } from "../src/shared/snapshot.ts";
import { normalizeQuery } from "../src/shared/text.ts";
import { toUnitFloat64, validateVector } from "../src/shared/vector.ts";

interface EvalItem {
  id: string;
  split?: "tune" | "eval";
  type?: string;
  query: string;
  category?: string | null;
  expected_ids: string[];
  expected_status: SearchStatus;
}

interface Prediction {
  item: EvalItem;
  status: SearchStatus | "error";
  ids: string[];
  rawTop3?: string[];
  topScore?: number;
}

const { values } = parseArgs({
  options: {
    set: { type: "string", default: "eval/eval-set.local.json" },
    api: { type: "boolean", default: false },
    sweep: { type: "boolean", default: false },
    min: { type: "string" },
    margin: { type: "string" },
    "max-false-matched": { type: "string", default: "0.10" },
    split: { type: "string", default: "eval" },
  },
});

const items = JSON.parse(await readFile(values.set!, "utf8")) as EvalItem[];
if (!Array.isArray(items) || items.length === 0) throw new Error("評価セットが空です");

function metrics(preds: Prediction[]) {
  const inScope = preds.filter((p) => p.item.expected_ids.length > 0);
  const outScope = preds.filter((p) => p.item.expected_status === "no_match");
  const expAmb = preds.filter((p) => p.item.expected_status === "ambiguous");
  const expMatched = preds.filter((p) => p.item.expected_status === "matched");
  const hit = (p: Prediction, ids: string[] | undefined) => (ids ?? []).slice(0, 3).some((id) => p.item.expected_ids.includes(id));
  const rate = (n: number, d: number) => (d === 0 ? null : n / d);
  const confusion: Record<string, Record<string, number>> = {};
  for (const p of preds) {
    confusion[p.item.expected_status] ??= {};
    confusion[p.item.expected_status]![p.status] = (confusion[p.item.expected_status]![p.status] ?? 0) + 1;
  }
  return {
    n: preds.length,
    top3_recall: rate(inScope.filter((p) => hit(p, p.ids)).length, inScope.length),
    top3_recall_before_threshold: preds.some((p) => p.rawTop3)
      ? rate(inScope.filter((p) => hit(p, p.rawTop3)).length, inScope.length)
      : null, // API評価ではしきい値適用前の順位を取得できない
    false_matched_rate: rate(outScope.filter((p) => p.status === "matched").length, outScope.length),
    out_of_scope_ambiguous_rate: rate(outScope.filter((p) => p.status === "ambiguous").length, outScope.length),
    ambiguous_detected_rate: rate(expAmb.filter((p) => p.status === "ambiguous").length, expAmb.length),
    over_ambiguous_rate: rate(expMatched.filter((p) => p.status === "ambiguous").length, expMatched.length),
    in_scope_no_match_rate: rate(inScope.filter((p) => p.status === "no_match").length, inScope.length),
    errors: preds.filter((p) => p.status === "error").length,
    confusion,
  };
}

const fmt = (v: number | null) => (v === null ? "-" : `${(v * 100).toFixed(1)}%`);
function printMetrics(title: string, m: ReturnType<typeof metrics>) {
  console.log(`\n## ${title}（n=${m.n}）`);
  console.log(`Top-3正解包含率            ${fmt(m.top3_recall)}（しきい値適用前 ${fmt(m.top3_recall_before_threshold)}）目標 ≥ 90%`);
  console.log(`対象外の誤matched率         ${fmt(m.false_matched_rate)} 目標 ≤ 10%`);
  console.log(`対象外のambiguous率         ${fmt(m.out_of_scope_ambiguous_rate)}`);
  console.log(`曖昧質問のambiguous検出率   ${fmt(m.ambiguous_detected_rate)}`);
  console.log(`通常質問の過剰ambiguous率   ${fmt(m.over_ambiguous_rate)}`);
  console.log(`対象内のno_match率          ${fmt(m.in_scope_no_match_rate)}`);
  console.log(`混同行列（期待→予測）       ${JSON.stringify(m.confusion)}`);
  if (m.errors) console.log(`エラー                      ${m.errors}`);
}

const report: Record<string, unknown> = { set: values.set, created_at: new Date().toISOString() };

if (values.api) {
  const url = process.env.SEARCH_API_URL?.replace(/\/+$/, "");
  if (!url) throw new Error("SEARCH_API_URL が未設定です");
  const preds: Prediction[] = [];
  for (const item of items) {
    const res = await fetch(`${url}/v1/faq/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.FAQ_SEARCH_API_KEY ?? ""}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: item.query, ...(item.category ? { category: item.category } : {}), limit: 3, request_id: `eval-${item.id}` }),
    });
    const body = (await res.json()) as { status?: SearchStatus; results?: { id: string; score: number }[] };
    preds.push({
      item,
      status: res.ok && body.status ? body.status : "error",
      ids: body.results?.map((r) => r.id) ?? [],
      topScore: body.results?.[0]?.score,
    });
  }
  const m = metrics(preds);
  printMetrics("API評価", m);
  report.mode = "api";
  report.metrics = m;
} else {
  const cfg = loadCliConfig(process.env, ["KINTONE_READ_API_TOKEN", "KINTONE_WRITE_API_TOKEN"]);
  const f = cfg.fields;
  const { records } = await fetchAllRecords(cfg.kintone, [f.category, f.question, f.answer, f.embedding, f.embeddingSpec, f.embeddingHash]);
  const snap = await buildSnapshot(records, { fields: f, specId: cfg.specId, dimensions: cfg.embedding.dimensions });
  console.log(`FAQ 有効 ${snap.validCount}/${snap.fetchedCount} 件 ${JSON.stringify(snap.invalidReasons)}`);
  const entries: FaqEntry[] = snap.entries;
  const known = new Set(entries.map((e) => e.id));
  for (const it of items) for (const id of it.expected_ids) if (!known.has(id)) console.log(`WARN 評価項目 ${it.id} の正解ID ${id} が有効FAQにありません`);

  const raws = await createEmbeddings(cfg.embedding, items.map((i) => normalizeQuery(i.query)));
  const qvecs = raws.map((raw, i) => {
    const v = validateVector(raw, cfg.embedding.dimensions);
    if (!v.ok) throw new Error(`質問 ${items[i]!.id} のベクトルが不正: ${v.reason}`);
    return toUnitFloat64(v.vector, v.norm);
  });

  const predictAll = (subset: number[], min: number, margin: number): Prediction[] =>
    subset.map((i) => {
      const item = items[i]!;
      const out = rank(entries, {
        queryUnit: qvecs[i]!,
        category: item.category ?? undefined,
        limit: 3,
        minSimilarity: min,
        ambiguityMargin: margin,
      });
      return {
        item,
        status: out.status,
        ids: out.results.map((r) => r.entry.id),
        rawTop3: out.allScored.slice(0, 3).map((r) => r.entry.id),
        topScore: out.allScored[0]?.score,
      };
    });

  const idx = (split?: string) => items.map((it, i) => ({ it, i })).filter(({ it }) => !split || (it.split ?? "eval") === split).map(({ i }) => i);
  const tuneIdx = idx("tune");
  const evalIdx = idx("eval");

  // スコア分布（しきい値決定の参考）
  const dist = predictAll(idx(), -1, 0).map((p) => ({ id: p.item.id, type: p.item.type, expected: p.item.expected_status, top: Number(p.topScore?.toFixed(4)) }));
  console.log("\n## 最上位スコア分布（期待状態別）");
  for (const st of ["matched", "ambiguous", "no_match"]) {
    const s = dist.filter((d) => d.expected === st).map((d) => d.top).sort((a, b) => a - b);
    if (s.length) console.log(`${st.padEnd(10)} n=${s.length} min=${s[0]} median=${s[Math.floor(s.length / 2)]} max=${s.at(-1)}`);
  }
  report.score_distribution = dist;

  let min = Number(values.min ?? process.env.MIN_SIMILARITY ?? NaN);
  let margin = Number(values.margin ?? process.env.AMBIGUITY_MARGIN ?? NaN);

  if (values.sweep) {
    if (tuneIdx.length === 0) throw new Error("--sweep には split=tune の項目が必要です");
    const maxFalse = Number(values["max-false-matched"]);
    const candidates: { min: number; margin: number; m: ReturnType<typeof metrics> }[] = [];
    for (let mi = 0; mi <= 90; mi++) {
      const mn = Number((0.05 + mi * 0.01).toFixed(2));
      for (const mg of [0, 0.005, 0.01, 0.015, 0.02, 0.03, 0.04, 0.05]) {
        candidates.push({ min: mn, margin: mg, m: metrics(predictAll(tuneIdx, mn, mg)) });
      }
    }
    const feasible = candidates.filter((c) => (c.m.false_matched_rate ?? 0) <= maxFalse);
    const score = (c: (typeof candidates)[number]) =>
      (c.m.top3_recall ?? 0) * 100 + (c.m.ambiguous_detected_rate ?? 0) * 10 - (c.m.over_ambiguous_rate ?? 0) * 10 - (c.m.out_of_scope_ambiguous_rate ?? 0) * 5;
    const best = (feasible.length ? feasible : candidates).sort((a, b) => score(b) - score(a))[0]!;
    if (!feasible.length) console.log(`WARN 誤matched率 ≤ ${maxFalse} を満たす候補がありません`);
    min = best.min;
    margin = best.margin;
    console.log(`\n調整用セットで選んだ候補: MIN_SIMILARITY=${min} AMBIGUITY_MARGIN=${margin}`);
    printMetrics("調整用（tune）", best.m);
    report.sweep = { chosen: { min, margin }, tune_metrics: best.m };
  }

  if (!Number.isFinite(min) || !Number.isFinite(margin)) {
    throw new Error("--min/--margin（または MIN_SIMILARITY/AMBIGUITY_MARGIN）か --sweep を指定してください");
  }
  const useAll = values.split === "all" || evalIdx.length === 0;
  const target = useAll ? idx() : idx(values.split);
  const m = metrics(predictAll(target, min, margin));
  printMetrics(`${useAll ? "全件" : values.split} MIN_SIMILARITY=${min} AMBIGUITY_MARGIN=${margin}`, m);
  console.log("\n※ 小規模な評価集合の結果であり、一般的な精度保証ではありません。");
  Object.assign(report, { mode: "offline", embedding_spec: cfg.specId, min_similarity: min, ambiguity_margin: margin, metrics: m });
}

await mkdir("reports", { recursive: true });
const out = `reports/eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await writeFile(out, JSON.stringify(report, null, 2));
console.log(`\n評価記録: ${out}`);
