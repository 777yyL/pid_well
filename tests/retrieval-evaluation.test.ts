import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateRetrieval,
  retrievalEvaluationSchema,
  runRetrievalEvaluation,
} from "../shared/retrieval-evaluation.js";

test("retrieval metrics deduplicate IDs, honor K and count errors as zero recall", () => {
  const data = retrievalEvaluationSchema.parse({
    topK: 2,
    cases: [
      { id: "a", query: "访客预约", expectedSaleItemIds: ["s1", "s1", "s2"] },
      { id: "b", query: "视频", expectedSaleItemIds: ["s3"] },
    ],
  });
  const result = evaluateRetrieval(data, [
    {
      id: "a",
      saleItemIds: ["unlabeled", "unlabeled", "s1", "s2"],
      elapsedMs: 100,
      timings: { embeddingMs: 20 },
    },
    { id: "b", saleItemIds: [], elapsedMs: 300, error: "HTTP 503" },
  ]);
  assert.equal(result.cases[0].recallAtK, 0.5);
  assert.equal(result.cases[0].reciprocalRank, 0.5);
  assert.deepEqual(result.cases[0].missingSaleItemIds, ["s2"]);
  assert.equal(result.summary.macroRecallAtK, 0.25);
  assert.equal(result.summary.mrr, 0.25);
  assert.equal(result.summary.hitRateAtK, 0.5);
  assert.equal(result.summary.failureCount, 1);
  assert.equal(result.summary.latencyMs.p95, 300);
  assert.equal(result.summary.successfulLatencyMs.p95, 100);
  assert.deepEqual(result.cases[0].timings, { embeddingMs: 20 });
  assert.ok(!("precision" in result.summary));
});

test("dataset requires nonempty gold and unique case IDs; missing observations are failures", () => {
  assert.throws(() =>
    retrievalEvaluationSchema.parse({
      cases: [{ id: "x", query: "x", expectedSaleItemIds: [] }],
    }),
  );
  assert.throws(() =>
    retrievalEvaluationSchema.parse({
      cases: [
        { id: "x", query: "x", expectedSaleItemIds: ["s"] },
        { id: "x", query: "y", expectedSaleItemIds: ["s"] },
      ],
    }),
  );
  const r = evaluateRetrieval(
    { cases: [{ id: "x", query: "x", expectedSaleItemIds: ["s"] }] },
    [],
  );
  assert.equal(r.summary.failureCount, 1);
  assert.equal(r.summary.latencyMs.p95, null);
});

test("runner bounds concurrency, preserves filters and records failed calls", async () => {
  let active = 0,
    max = 0;
  const seen: string[] = [];
  const r = await runRetrievalEvaluation(
    {
      cases: Array.from({ length: 5 }, (_, i) => ({
        id: String(i),
        query: "q" + i,
        expectedSaleItemIds: ["s"],
        versionIds: ["v"],
      })),
    },
    async (c, options) => {
      active++;
      max = Math.max(max, active);
      seen.push(...c.versionIds!);
      assert.equal(options.topK, 10);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (c.id === "2") throw new Error("HTTP 500");
      return { saleItemIds: ["s"], timings: { queryMs: 2 } };
    },
  );
  assert.equal(max, 2);
  assert.equal(seen.length, 5);
  assert.equal(r.summary.failureCount, 1);
  assert.equal(r.summary.hitRateAtK, 0.8);
  assert.ok(r.cases.every((c) => c.elapsedMs !== null));
});

test("CLI authenticates live requests, sends filters and retains only safe timing fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "retrieval-eval-"));
  let received: any;
  const provider = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received = {
      url: req.url,
      cookie: req.headers.cookie,
      header: req.headers["x-workspace-request"],
      body: JSON.parse(Buffer.concat(chunks).toString()),
    };
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        results: [{ saleItemId: "s" }],
        timings: { retrievalMs: 12, unsafe: "not-a-timing" },
      }),
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  try {
    const path = join(directory, "cases.json");
    await writeFile(
      path,
      JSON.stringify({
        cases: [
          {
            id: "x",
            query: "人脸访客",
            expectedSaleItemIds: ["s"],
            productIds: ["p"],
            versionIds: ["v"],
          },
        ],
      }),
    );
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "scripts/evaluate-retrieval.ts", path],
      {
        env: {
          ...process.env,
          RETRIEVAL_EVAL_COOKIE: "workspace_session=secret-fixture",
          RETRIEVAL_EVAL_BASE_URL: `http://127.0.0.1:${(provider.address() as { port: number }).port}`,
        },
      },
    );
    assert.equal(stderr, "");
    assert.ok(!stdout.includes("secret-fixture"));
    assert.equal(received.cookie, "workspace_session=secret-fixture");
    assert.equal(received.header, "1");
    assert.equal(received.url, "/api/knowledge/search");
    assert.deepEqual(received.body.versionIds, ["v"]);
    assert.deepEqual(received.body.productIds, ["p"]);
    const report = JSON.parse(stdout);
    assert.equal(report.summary.macroRecallAtK, 1);
    assert.deepEqual(report.cases[0].timings, { retrievalMs: 12 });
  } finally {
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
