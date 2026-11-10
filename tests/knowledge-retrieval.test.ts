import test from "node:test";
import assert from "node:assert/strict";
import { rankKnowledge } from "../server/knowledge-retrieval.js";

test("keyword, vector and hybrid rank only supplied scoped documents; thresholds never fill with weak hits", async () => {
  const docs = [
    {
      id: "ps",
      title: "人身检查",
      text: "检查登记并拍照留痕",
      productId: "PS",
      versionId: "v1",
      categoryId: "c",
    },
    {
      id: "isc",
      title: "视频监控",
      text: "视频管理",
      productId: "ISC",
      versionId: "v2",
      categoryId: "c2",
    },
  ];
  const embed = async (texts: string[]) =>
    texts.map((t) => (t.includes("视频") ? [0, 1] : [1, 0]));
  const scoped = docs.filter(
    (d) => d.productId === "PS" && d.versionId === "v1",
  );
  for (const mode of ["keyword", "vector", "hybrid"] as const) {
    const hits = await rankKnowledge(
      scoped,
      "人身检查",
      { mode, topK: 10 },
      embed,
    );
    assert.deepEqual(
      hits.map((h) => h.id),
      ["ps"],
    );
    assert.equal(hits[0].productId, "PS");
  }
  for (const mode of ["vector", "hybrid"] as const)
    assert.deepEqual(
      await rankKnowledge(
        scoped,
        "视频",
        { mode, topK: 10, minSimilarity: 0.8 },
        embed,
      ),
      [],
    );
  assert.deepEqual(
    await rankKnowledge(scoped, "不存在的模块", { mode: "keyword", topK: 1 }),
    [],
  );
  await assert.rejects(
    () => rankKnowledge(scoped, "检查", { mode: "vector", topK: 1 }),
    /Embedding/,
  );
});
