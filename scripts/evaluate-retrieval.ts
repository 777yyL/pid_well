import { readFile } from "node:fs/promises";
import {
  retrievalEvaluationSchema,
  runRetrievalEvaluation,
} from "../shared/retrieval-evaluation.js";

// Usage: pnpm evaluate:retrieval labeled-retrieval.json
// Auth cookie stays in RETRIEVAL_EVAL_COOKIE, never in the dataset or output.
try {
  if (!process.argv[2])
    throw new Error(
      "请提供人工标注JSON文件：{cases:[{id,query,expectedSaleItemIds,productIds?,versionIds?}],topK?,mode?}",
    );
  const dataset = retrievalEvaluationSchema.parse(
    JSON.parse(await readFile(process.argv[2], "utf8")),
  );
  const base = new URL(
    process.env.RETRIEVAL_EVAL_BASE_URL ?? "http://127.0.0.1:4317",
  );
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("评测地址必须为不含凭据的HTTP/HTTPS地址");
  const cookie = process.env.RETRIEVAL_EVAL_COOKIE;
  if (!cookie) throw new Error("请通过RETRIEVAL_EVAL_COOKIE配置登录会话Cookie");
  const result = await runRetrievalEvaluation(
    dataset,
    async (c, options) => {
      let response: Response;
      try {
        response = await fetch(new URL("/api/knowledge/search", base), {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(180000),
          headers: {
            "Content-Type": "application/json",
            "x-workspace-request": "1",
            Cookie: cookie,
          },
          body: JSON.stringify({
            query: c.query,
            topK: options.topK,
            mode: options.mode,
            productIds: c.productIds ?? [],
            versionIds: c.versionIds ?? [],
            includeContent: false,
          }),
        });
      } catch {
        throw new Error("请求连接失败或超时，请检查服务地址与网络");
      }
      if (!response.ok) throw new Error(`检索接口HTTP ${response.status}`);
      let body: any;
      try {
        body = await response.json();
      } catch {
        throw new Error("检索接口未返回JSON");
      }
      if (
        !Array.isArray(body.results) ||
        body.results.some(
          (r: any) => typeof r?.saleItemId !== "string" || !r.saleItemId,
        )
      )
        throw new Error("检索响应缺少有效销售项ID");
      if (
        body.index &&
        (Number(body.index.pending) > 0 || Number(body.index.failed) > 0)
      )
        throw new Error("检索索引尚未完整就绪，请完成索引或处理失败项后再评测");
      const timings =
        body.timings && typeof body.timings === "object"
          ? Object.fromEntries(
              Object.entries(body.timings).filter(
                ([, v]) =>
                  typeof v === "number" && Number.isFinite(v) && v >= 0,
              ),
            )
          : undefined;
      return {
        saleItemIds: body.results.map((r: any) => r.saleItemId),
        timings: timings as Record<string, number> | undefined,
      };
    },
    Number(process.env.RETRIEVAL_EVAL_CONCURRENCY ?? 2),
  );
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result.summary.failureCount) process.exitCode = 1;
} catch (error) {
  // Validation error paths are useful; never dump HTTP response bodies or headers.
  process.stderr.write(
    (error instanceof Error ? error.message : "评测失败") + "\n",
  );
  process.exitCode = 1;
}
