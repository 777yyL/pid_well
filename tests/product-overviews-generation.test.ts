import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { openDatabase, migrate } from "../server/db.js";
import { saveAgentSettings } from "../server/settings.js";
import {
  generateOverview,
  refreshProductOverviews,
  saveOverview,
} from "../server/product-overviews.js";
import { config } from "../server/config.js";

test("overview model batches only one product version, retains sale references and preserves manual edits", async () => {
  const previousTimeout = config.MODEL_REQUEST_TIMEOUT_MS;
  config.MODEL_REQUEST_TIMEOUT_MS = 10000;
  const requests: any[] = [];
  let invalid = false;
  let emptyReply = false;
  const provider = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(parts).toString());
    const input = JSON.parse(
      body.messages.find((m: any) => m.role === "user").content,
    );
    requests.push(input);
    const ids =
      input.sales?.map((s: any) => s.id) ??
      input.verifiedSummaries.flatMap((o: any) =>
        o.modules.flatMap((m: any) => m.saleItemIds),
      );
    const overview = {
      positioning: "办案业务平台",
      scenarios: [],
      modules: [
        {
          name: "流程管理",
          capabilities: ["原文中的流程能力"],
          saleItemIds: invalid ? ["outside"] : ids,
        },
      ],
      limitations: [],
      unspecified: ["容量未明确"],
    };
    res.setHeader("Content-Type", "text/event-stream");
    res.write(
      "data: " +
        JSON.stringify({
          id: "completion",
          object: "chat.completion.chunk",
          created: 1,
          model: "overview-test",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: emptyReply ? "" : JSON.stringify(overview) },
              finish_reason: null,
            },
          ],
        }) +
        "\n\n",
    );
    res.end(
      "data: " +
        JSON.stringify({
          id: "completion",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const db = await openDatabase("", "memory://");
  await migrate(db);
  const user = randomUUID();
  try {
    await db.query(
      "INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,'overview-admin','管理员','unused','admin')",
      [user],
    );
    await saveAgentSettings(db, user, {
      modelBaseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
      model: "overview-test",
      contextWindow: 64000,
      maxOutputTokens: 8192,
    });
    await db.query(
      "INSERT INTO kb_products(product_id,product_code,name,status) VALUES('p','PS','办案平台','active')",
    );
    await db.query(
      "INSERT INTO kb_product_versions(product_version_id,product_id,version,status) VALUES('v1','p','v1','active'),('v2','p','v2','active')",
    );
    for (let i = 0; i < 26; i++)
      await db.query(
        "INSERT INTO kb_sale_items(sale_item_id,product_version_id,name,specification_md,status) VALUES($1,'v1',$2,'支持登记流程','active')",
        ["s" + i, "流程" + i],
      );
    await db.query(
      "INSERT INTO kb_sale_items(sale_item_id,product_version_id,name,specification_md,status) VALUES('outside','v2','其他版本专用','不要出现在v1概览','active')",
    );
    const result = await generateOverview(
      db,
      user,
      "v1",
      AbortSignal.timeout(10000),
    );
    assert.equal(requests.length, 3);
    assert.equal(result.overview.modules[0].saleItemIds.length, 26);
    assert.ok(!JSON.stringify(requests).includes("其他版本专用"));
    invalid = true;
    await assert.rejects(
      () => generateOverview(db, user, "v1", AbortSignal.timeout(10000)),
      /其他产品版本/,
    );
    invalid = false;
    await db.query(
      "UPDATE kb_sale_items SET specification_md='新增流程能力' WHERE sale_item_id='s0'",
    );
    await refreshProductOverviews(db, AbortSignal.timeout(10000));
    assert.equal(requests.length, 7);
    await saveOverview(db, "v1", {
      ...result.overview,
      positioning: "人工修订的定位",
    });
    await db.query(
      "UPDATE kb_sale_items SET specification_md='再次变化' WHERE sale_item_id='s0'",
    );
    const before = requests.length;
    await refreshProductOverviews(db, AbortSignal.timeout(10000));
    assert.equal(requests.length, before);
    assert.equal(
      (
        await db.query<{ overview: { positioning: string } }>(
          "SELECT overview FROM kb_product_overviews WHERE product_version_id='v1'",
        )
      )[0].overview.positioning,
      "人工修订的定位",
    );
    emptyReply = true;
    await assert.rejects(
      () => generateOverview(db, user, "v1", AbortSignal.timeout(10000)),
      /模型未返回可用内容/,
    );
    await assert.rejects(
      () => generateOverview(db, user, "v1", AbortSignal.abort(new Error("test-abort"))),
      /test-abort/,
    );
  } finally {
    config.MODEL_REQUEST_TIMEOUT_MS = previousTimeout;
    await db.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
