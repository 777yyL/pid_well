import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate } from "../server/db.js";
import { cosine, prepareSemanticCatalog } from "../server/semantic-catalog.js";
import type { CatalogContext } from "../server/catalog-context.js";
import type { RequirementInput } from "../shared/domain.js";
import { createServer } from "node:http";
import { requestEmbeddings } from "../server/semantic-catalog.js";
import { config } from "../server/config.js";
import { saveSemanticSettings } from "../server/semantic-settings.js";
import { embeddingCache } from "../server/semantic-catalog.js";

test("兼容Embedding批量接口，按索引重排，拒绝错误响应", async () => {
  let broken = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.url, "/v1/embeddings");
    assert.equal(body.model, "test-embedding");
    assert.deepEqual(body.input, ["a", "b"]);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        data: broken
          ? [
              { index: 0, embedding: [0, 0] },
              { index: 0, embedding: [1, 0] },
            ]
          : [
              { index: 1, embedding: [0, 1] },
              { index: 0, embedding: [1, 0] },
            ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previous = {
    url: config.EMBEDDING_BASE_URL,
    model: config.EMBEDDING_MODEL,
  };
  config.EMBEDDING_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  config.EMBEDDING_MODEL = "test-embedding";
  try {
    assert.deepEqual(
      await requestEmbeddings(["a", "b"], new AbortController().signal),
      [
        [1, 0],
        [0, 1],
      ],
    );
    broken = true;
    await assert.rejects(
      () => requestEmbeddings(["a", "b"], new AbortController().signal),
      /索引无效/,
    );
  } finally {
    config.EMBEDDING_BASE_URL = previous.url;
    config.EMBEDDING_MODEL = previous.model;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("范围内混合检索保持全文与版本，向量缓存复用且内容变化失效", async () => {
  const db = await openDatabase("", "memory://");
  try {
    await migrate(db);
    await saveSemanticSettings(db, {
      enabled: true,
      baseUrl: "http://embedding.test/v1",
      model: "test",
      revision: "1",
      mode: "hybrid",
      topK: 10,
      timeoutMs: 1000,
    });
    const context = {
      scopeRevision: 1,
      index: Array.from({ length: 12 }, (_, i) => ({
        id: `S-${i}`,
        sales: i === 0 ? "校园访客" : `普通功能${i}`,
        product: "A",
        version: "v1",
        description: "",
        capabilities: "",
        category: "",
        moduleId: `${i}`,
      })),
      candidates: Array.from({ length: 12 }, (_, i) => ({
        path: `wiki/${i}.md`,
        snapshotId: `snapshot-${i}`,
        sales: i === 0 ? "校园访客" : `普通功能${i}`,
        product: "A",
        version: "v1",
        moduleId: `${i}`,
        excerpts: [
          {
            lineStart: 1,
            lineEnd: 2,
            quote:
              i === 0
                ? "人员预约后审批刷脸进入校园，必须先审批。"
                : "视频录像功能",
          },
        ],
      })),
    } as CatalogContext;
    let calls = 0;
    const embed = async (texts: string[]) => {
      calls++;
      return texts.map((t) =>
        t.includes("人员") || t.includes("客人") ? [1, 0] : [0, 1],
      );
    };
    const requirement = {
      id: "T-1",
      raw: "客人登记申请经许可后进入学校",
    } as RequirementInput;
    const search = await prepareSemanticCatalog(
      db,
      context,
      new AbortController().signal,
      embed,
    );
    const [packet] = await search([requirement], 3);
    assert.equal(packet.candidates.length, 3);
    assert.equal(packet.candidates[0], context.candidates[0]);
    assert.match(packet.candidates[0].excerpts[0].quote, /必须先审批/);
    assert.ok(
      packet.candidates.every((c) => c.product === "A" && c.version === "v1"),
    );
    const before = calls;
    const again = await prepareSemanticCatalog(
      db,
      context,
      new AbortController().signal,
      embed,
    );
    await again([requirement], 3);
    assert.equal(calls, before, "相同内容与模型不重复生成文档和需求向量");
    context.candidates[0].excerpts[0].quote += "新增限制";
    await prepareSemanticCatalog(
      db,
      context,
      new AbortController().signal,
      embed,
    );
    assert.equal(calls, before + 1);
    await assert.rejects(
      () =>
        prepareSemanticCatalog(
          db,
          {
            ...context,
            index: [context.index[0]],
            candidates: [
              {
                ...context.candidates[0],
                excerpts: [{ lineStart: 1, lineEnd: 1, quote: "新数据" }],
              },
            ],
          },
          new AbortController().signal,
          async () => {
            throw new Error("Embedding offline");
          },
        ),
      /Embedding offline/,
    );
  } finally {
    await db.close();
  }
});

test("余弦相似度验证维度，不将不一致向量混排", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.throws(() => cosine([1], [1, 0]), /维度/);
});

test("concurrent identical embedding work is coalesced and failed work can retry", async () => {
  const db = await openDatabase("", "memory://");
  await migrate(db);
  try {
    let calls = 0,
      fail = false;
    const settings = {
      enabled: true,
      baseUrl: "http://fixture/v1",
      model: "test",
      revision: "1",
      mode: "hybrid" as const,
      topK: 10,
      timeoutMs: 1000,
    };
    const generate = async (texts: string[]) => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      if (fail) throw new Error("offline");
      return texts.map(() => [1, 0]);
    };
    const first = embeddingCache(
      db,
      settings,
      new AbortController().signal,
      generate,
    );
    const second = embeddingCache(
      db,
      settings,
      new AbortController().signal,
      generate,
    );
    await Promise.all([first(["shared"]), second(["shared"])]);
    assert.equal(calls, 1);
    fail = true;
    await assert.rejects(() => first(["new"]), /offline/);
    fail = false;
    assert.deepEqual(await second(["new"]), [[1, 0]]);
    assert.equal(calls, 3);
  } finally {
    await db.close();
  }
});
