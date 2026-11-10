import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openDatabase } from "../server/db.js";
import {
  loadRerankSettings,
  saveRerankSettings,
  requestRerank,
  rerankSettingsView,
} from "../server/reranker.js";

test("rerank validates provider results, timeout and encrypted configuration", async () => {
  const db = await openDatabase("", "memory://");
  await db.query(
    "CREATE TABLE rerank_settings(id integer PRIMARY KEY,value jsonb NOT NULL)",
  );
  let malformed = false;
  let delayMs = 0;
  const server = createServer(async (req, res) => {
    const buffers: Buffer[] = [];
    for await (const b of req) buffers.push(Buffer.from(b));
    const body = JSON.parse(Buffer.concat(buffers).toString());
    assert.equal(req.url, "/v1/rerank");
    assert.equal(req.headers.authorization, "Bearer test-secret");
    assert.deepEqual(body.documents, ["门禁", "访客预约"]);
    assert.equal(body.top_n, 2);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        results: malformed
          ? [
              { index: 0, relevance_score: 1 },
              { index: 0, relevance_score: 0 },
            ]
          : [
              { index: 1, relevance_score: 0.9 },
              { index: 0, relevance_score: 0.2 },
            ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const settings = {
      enabled: true,
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      model: "rerank-test",
      apiKey: "test-secret",
      timeoutMs: 1000,
      candidateLimit: 40,
    };
    assert.equal((await loadRerankSettings(db)).enabled, false);
    await saveRerankSettings(db, settings);
    const [stored] = await db.query<{ value: { apiKey: string } }>(
      "SELECT value FROM rerank_settings",
    );
    assert.notEqual(stored.value.apiKey, "test-secret");
    assert.equal(
      JSON.stringify(rerankSettingsView(await loadRerankSettings(db))).includes(
        "test-secret",
      ),
      false,
    );
    await saveRerankSettings(db, { ...settings, apiKey: undefined });
    assert.equal((await loadRerankSettings(db)).apiKey, "test-secret");
    assert.deepEqual(
      await requestRerank(
        "访客预约",
        ["门禁", "访客预约"],
        settings,
        new AbortController().signal,
      ),
      [
        { index: 1, score: 0.9 },
        { index: 0, score: 0.2 },
      ],
    );
    malformed = true;
    await assert.rejects(
      () =>
        requestRerank(
          "访客预约",
          ["门禁", "访客预约"],
          settings,
          new AbortController().signal,
        ),
      /索引|无效/,
    );
    malformed = false;
    delayMs = 1300;
    await assert.rejects(
      () =>
        requestRerank(
          "访客预约",
          ["门禁", "访客预约"],
          settings,
          new AbortController().signal,
        ),
      /timeout/i,
    );
    await assert.rejects(
      () =>
        requestRerank(
          "访客预约",
          ["门禁", "访客预约"],
          settings,
          AbortSignal.abort(new Error("cancelled")),
        ),
      /cancelled/,
    );
    await assert.rejects(() =>
      saveRerankSettings(db, {
        ...settings,
        baseUrl: "http://user:secret@localhost/v1",
      }),
    );
    await saveRerankSettings(db, { ...settings, apiKey: "" });
    assert.equal((await loadRerankSettings(db)).apiKey, "");
  } finally {
    await db.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
