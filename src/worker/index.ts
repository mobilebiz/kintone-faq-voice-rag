/**
 * Cloudflare Workers エントリーポイント。
 * キャッシュはモジュールスコープ（isolate 単位）に置く。isolate ごとに独立してミスし、保持期間も保証されない。
 */
import { createApp } from "./app.ts";
import type { Env } from "./config.ts";

const app = createApp();

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return app.fetch(request, env);
  },
};
