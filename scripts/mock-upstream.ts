/**
 * ローカル確認用のモック上流サーバー（kintone + OpenAI Embeddings 互換の最小実装）。
 *   npm run mock:upstream            # 索引済みのサンプルFAQで起動
 *   npm run mock:upstream -- --no-preindex   # 未索引で起動（index:faq を試す）
 * 環境変数: MOCK_PORT(8788) / MOCK_DIMENSIONS(256) / MOCK_SPEC_ID
 */
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { MockUpstream } from "./mock-upstream-core.ts";
import { SAMPLE_FAQ } from "./sample-faq.ts";

const { values } = parseArgs({ options: { "no-preindex": { type: "boolean", default: false } } });
const port = Number(process.env.MOCK_PORT ?? "8788");
const dims = Number(process.env.MOCK_DIMENSIONS ?? "256");
const specId = process.env.MOCK_SPEC_ID ?? `openai/mock-hash-embedding/${dims}/faq-v1`;

const mock = new MockUpstream({ defaultDimensions: dims });
mock.addFaq(SAMPLE_FAQ);
if (!values["no-preindex"]) await mock.preindex(specId, dims);

const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    const response = await mock.handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    console.log(`${req.method} ${new URL(request.url).pathname} -> ${response.status}`);
  } catch (err) {
    res.writeHead(500);
    res.end();
    console.error(err);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock upstream listening on http://127.0.0.1:${port}`);
  console.log(`  kintone:   KINTONE_BASE_URL=http://127.0.0.1:${port}  KINTONE_APP_ID=146  token=mock-token`);
  console.log(`  embedding: EMBEDDING_BASE_URL=http://127.0.0.1:${port}/v1  EMBEDDING_API_KEY=mock-key  dims=${dims}`);
  console.log(`  spec id:   ${specId}  (preindex=${!values["no-preindex"]})`);
});
