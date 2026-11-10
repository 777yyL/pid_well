import { z } from "zod";

const ids = z.array(z.string().trim().min(1));
export const retrievalEvaluationSchema = z
  .object({
    topK: z.number().int().min(1).max(100).default(10),
    mode: z.enum(["keyword", "vector", "hybrid"]).default("hybrid"),
    cases: z
      .array(
        z.object({
          id: z.string().trim().min(1),
          query: z.string().trim().min(1).max(4000),
          expectedSaleItemIds: ids.min(1),
          productIds: ids.optional(),
          versionIds: ids.optional(),
        }),
      )
      .min(1),
  })
  .refine(
    (d) => new Set(d.cases.map((c) => c.id)).size === d.cases.length,
    "评测案例编号不能重复",
  );
export type RetrievalCase = z.infer<
  typeof retrievalEvaluationSchema
>["cases"][number];
export type RetrievalObservation = {
  id: string;
  saleItemIds: string[];
  elapsedMs: number;
  timings?: Record<string, number>;
  error?: string;
};
const percentile = (values: number[], q: number) =>
  values.length
    ? [...values].sort((a, b) => a - b)[
        Math.max(0, Math.ceil(values.length * q) - 1)
      ]
    : null;
const latency = (values: number[]) => ({
  samples: values.length,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
});

export function evaluateRetrieval(
  input: z.input<typeof retrievalEvaluationSchema>,
  observations: RetrievalObservation[],
) {
  const data = retrievalEvaluationSchema.parse(input);
  if (new Set(observations.map((o) => o.id)).size !== observations.length)
    throw new Error("检索结果案例编号重复");
  const lookup = new Map(observations.map((o) => [o.id, o]));
  const cases = data.cases.map((c) => {
    const o = lookup.get(c.id);
    const error = o?.error ?? (!o ? "未执行" : undefined);
    const found = error ? [] : [...new Set(o!.saleItemIds)].slice(0, data.topK);
    const expected = [...new Set(c.expectedSaleItemIds)];
    const hits = expected.filter((id) => found.includes(id));
    const first = found.findIndex((id) => expected.includes(id));
    return {
      id: c.id,
      query: c.query,
      expectedSaleItemIds: expected,
      returnedSaleItemIds: found,
      missingSaleItemIds: expected.filter((id) => !found.includes(id)),
      recallAtK: hits.length / expected.length,
      hitAtK: hits.length ? 1 : 0,
      reciprocalRank: first < 0 ? 0 : 1 / (first + 1),
      elapsedMs:
        o && Number.isFinite(o.elapsedMs) && o.elapsedMs >= 0
          ? o.elapsedMs
          : null,
      timings: o?.timings,
      error: error ?? null,
    };
  });
  const average = (f: (c: (typeof cases)[number]) => number) =>
    cases.reduce((sum, c) => sum + f(c), 0) / cases.length;
  const times = cases.flatMap((c) =>
    c.elapsedMs === null ? [] : [c.elapsedMs],
  );
  const successTimes = cases.flatMap((c) =>
    c.error || c.elapsedMs === null ? [] : [c.elapsedMs],
  );
  return {
    topK: data.topK,
    mode: data.mode,
    summary: {
      caseCount: cases.length,
      failureCount: cases.filter((c) => c.error).length,
      macroRecallAtK: average((c) => c.recallAtK),
      mrr: average((c) => c.reciprocalRank),
      hitRateAtK: average((c) => c.hitAtK),
      latencyMs: latency(times),
      successfulLatencyMs: latency(successTimes),
      policy:
        "失败案例的召回率、命中率及倒数排名记为0；延迟包括已执行失败请求，另列成功请求延迟。仅标注正例，不计算Precision。",
    },
    cases,
  };
}

export async function runRetrievalEvaluation(
  input: z.input<typeof retrievalEvaluationSchema>,
  retrieve: (
    c: RetrievalCase,
    options: { topK: number; mode: "keyword" | "vector" | "hybrid" },
  ) => Promise<{ saleItemIds: string[]; timings?: Record<string, number> }>,
  concurrency = 2,
) {
  const data = retrievalEvaluationSchema.parse(input);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error("并发数必须为1至8");
  const observations: RetrievalObservation[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, data.cases.length) },
      async () => {
        while (cursor < data.cases.length) {
          const c = data.cases[cursor++],
            start = performance.now();
          try {
            const result = await retrieve(c, data);
            observations.push({
              id: c.id,
              ...result,
              elapsedMs: performance.now() - start,
            });
          } catch (error) {
            observations.push({
              id: c.id,
              saleItemIds: [],
              elapsedMs: performance.now() - start,
              error: error instanceof Error ? error.message : "检索请求失败",
            });
          }
        }
      },
    ),
  );
  return evaluateRetrieval(data, observations);
}
