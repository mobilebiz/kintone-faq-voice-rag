/**
 * ヘッジリクエスト：1本目が delayMs 以内に終わらなければ同じ処理をもう1本並行して始め、先に成功した方を使う。
 * 負けた方は中止する。新しい isolate の初回に上流への接続確立だけが詰まる場合の対策（2026-10-01 の本番ログで
 * Embedding が 3,500ms で打ち切られ、直後の2回目は 427ms だった）。
 *
 * - delayMs <= 0 なら1本だけ実行する。
 * - 2本目を始める前に1本目が失敗したら、ヘッジせずその失敗を返す（認証エラー等を二重に送らない）。
 * - 2本とも失敗したら、先に失敗した方のエラーを返す。
 */
export type HedgeWinner = "primary" | "hedge";

export interface HedgeResult<T> {
  value: T;
  winner: HedgeWinner;
}

export function hedged<T>(
  run: (signal: AbortSignal) => Promise<T>,
  delayMs: number,
  signal: AbortSignal,
): Promise<HedgeResult<T>> {
  return new Promise((resolve, reject) => {
    const attempts: AbortController[] = [];
    let firstError: unknown;
    let failed = 0;
    let settled = false;
    let hedgePending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const c of attempts) c.abort();
      fn();
    };

    const start = (winner: HedgeWinner) => {
      const ctrl = new AbortController();
      attempts.push(ctrl);
      run(AbortSignal.any([signal, ctrl.signal])).then(
        (value) => finish(() => resolve({ value, winner })),
        (err) => {
          if (failed++ === 0) firstError = err;
          // 2本目を待っている間の失敗、または始めた全本の失敗で確定する
          if (hedgePending || failed === attempts.length) finish(() => reject(firstError));
        },
      );
    };

    start("primary");
    if (delayMs > 0 && !signal.aborted) {
      hedgePending = true;
      timer = setTimeout(() => {
        hedgePending = false;
        if (!settled) start("hedge");
      }, delayMs);
    }
  });
}
