import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate } from "../server/db.js";
import {
  refreshKnowledgeIndex,
  searchKnowledge,
} from "../server/knowledge-search.js";
import { createServer } from "node:http";
import { saveSemanticSettings } from "../server/semantic-settings.js";
import { saveRerankSettings } from "../server/reranker.js";
import {
  retryKnowledgeIndex,
  knowledgeIndexWorkerState,
} from "../server/retrieval-index.js";
import { prepareSemanticCatalog } from "../server/semantic-catalog.js";
import { knowledgePath } from "../server/structured-knowledge.js";
import { LIVE_KNOWLEDGE_ID } from "../server/product-knowledge.js";
import type { CatalogContext } from "../server/catalog-context.js";
import type { RequirementInput } from "../shared/domain.js";

test("worker exposes errors before claiming any jobs and clears them after recovery", async () => {
  const db = await openDatabase("", "memory://");
  await migrate(db);
  let unavailable = true;
  const workerDb: typeof db = {
    ...db,
    query: async (sql, params) => {
      if (unavailable && sql.includes("FROM semantic_settings"))
        throw new Error("configuration could not be decrypted");
      return db.query(sql, params);
    },
  };
  try {
    await assert.rejects(
      refreshKnowledgeIndex(workerDb, new AbortController().signal),
      /configuration could not be decrypted/,
    );
    assert.equal(knowledgeIndexWorkerState(workerDb).status, "failed");
    assert.match(
      knowledgeIndexWorkerState(workerDb).error!,
      /configuration could not be decrypted/,
    );
    unavailable = false;
    await refreshKnowledgeIndex(workerDb, new AbortController().signal);
    assert.equal(knowledgeIndexWorkerState(workerDb).status, "idle");
    assert.equal(knowledgeIndexWorkerState(workerDb).error, undefined);
  } finally {
    await db.close();
  }
});

test("rebuild populates missing index jobs after an external database import", async () => {
  const db = await openDatabase("", "memory://");
  try {
    await migrate(db);
    await db.query(
      "INSERT INTO kb_products(product_id,product_code,name,status) VALUES('imported','Imported','导入产品','active')",
    );
    await db.query(
      "INSERT INTO kb_product_versions(product_version_id,product_id,version,status) VALUES('imported-v1','imported','v1','active')",
    );
    await db.query(
      "INSERT INTO kb_sale_items(sale_item_id,product_version_id,name,specification_md,status) VALUES('imported-sale','imported-v1','访客管理','支持访客预约审批','active')",
    );
    // Some restore/import tools omit derived tables or disable triggers while copying.
    await db.query("DELETE FROM kb_index_state");
    const before = await searchKnowledge(db, {
      query: "访客预约",
      mode: "keyword",
    });
    assert.deepEqual(before.index, {
      total: 1,
      ready: 0,
      failed: 0,
      pending: 1,
    });
    await retryKnowledgeIndex(db, true);
    assert.equal(
      (await db.query("SELECT sale_item_id FROM kb_index_state")).length,
      1,
      "rebuild must enqueue source records with no existing job",
    );
    await refreshKnowledgeIndex(db, new AbortController().signal);
    assert.equal(
      (await searchKnowledge(db, { query: "访客预约", mode: "keyword" }))
        .results[0].saleItemId,
      "imported-sale",
    );
  } finally {
    await db.close();
  }
});

test("persistent keyword index updates outside queries and synchronizes direct SQL writes and deletes", async () => {
  const db = await openDatabase("", "memory://");
  try {
    await migrate(db);
    await db.query(
      "INSERT INTO kb_products(product_id,product_code,name,status) VALUES('p','PS','办案平台','active')",
    );
    await db.query(
      "INSERT INTO kb_product_versions(product_version_id,product_id,version,status) VALUES('v','p','v1','active')",
    );
    await db.query(
      "INSERT INTO kb_sale_items(sale_item_id,product_version_id,name,specification_md,status) VALUES('s','v','出入区管理','支持预约审批及人员登记','active')",
    );
    const before = await searchKnowledge(db, {
      query: "预约审批",
      mode: "keyword",
    });
    assert.equal(
      before.results.length,
      0,
      "query must not construct the missing index",
    );
    assert.equal(before.index.pending, 1);
    await refreshKnowledgeIndex(db, new AbortController().signal);
    const result = await searchKnowledge(db, {
      query: "预约审批",
      mode: "keyword",
      includeContent: true,
    });
    assert.equal(result.engine, "postgres-fts");
    assert.deepEqual(
      result.results.map((r) => r.saleItemId),
      ["s"],
    );
    assert.match(result.results[0].content!, /预约审批/);
    assert.ok(result.timings.totalMs >= 0);
    await db.query(
      "UPDATE kb_sale_items SET specification_md='支持随身物品暂存' WHERE sale_item_id='s'",
    );
    assert.equal(
      (await searchKnowledge(db, { query: "预约审批", mode: "keyword" }))
        .results.length,
      0,
      "stale index is hidden immediately",
    );
    await refreshKnowledgeIndex(db, new AbortController().signal);
    assert.deepEqual(
      (
        await searchKnowledge(db, { query: "随身物品暂存", mode: "keyword" })
      ).results.map((r) => r.saleItemId),
      ["s"],
    );
    await db.query("DELETE FROM kb_sale_items WHERE sale_item_id='s'");
    assert.equal(
      (await searchKnowledge(db, { query: "随身物品暂存", mode: "keyword" }))
        .results.length,
      0,
    );
  } finally {
    await db.close();
  }
});

test("cleanup removes only dirty inactive sales across sale, version and product status changes", async () => {
  const db = await openDatabase("", "memory://");
  try {
    await migrate(db);
    for (const id of ["sale", "version", "product", "active"]) {
      await db.query(
        "INSERT INTO kb_products(product_id,product_code,name,status) VALUES($1,$1,$1,'active')",
        [id],
      );
      await db.query(
        "INSERT INTO kb_product_versions(product_version_id,product_id,version,status) VALUES($1,$1,'v1','active')",
        [id],
      );
      await db.query(
        "INSERT INTO kb_sale_items(sale_item_id,product_version_id,name,status) VALUES($1,$1,$1,'active')",
        [id],
      );
    }
    await refreshKnowledgeIndex(db, new AbortController().signal);
    assert.equal(
      (await db.query("SELECT sale_item_id FROM kb_search_documents")).length,
      4,
    );
    await db.query(
      "UPDATE kb_sale_items SET status='retired' WHERE sale_item_id='sale'",
    );
    await db.query(
      "UPDATE kb_product_versions SET status='retired' WHERE product_version_id='version'",
    );
    await db.query(
      "UPDATE kb_products SET status='retired' WHERE product_id='product'",
    );
    await refreshKnowledgeIndex(db, new AbortController().signal);
    assert.deepEqual(
      await db.query("SELECT sale_item_id FROM kb_search_documents"),
      [{ sale_item_id: "active" }],
    );
    await db.query(
      "UPDATE kb_products SET status='active' WHERE product_id='product'",
    );
    await refreshKnowledgeIndex(db, new AbortController().signal);
    assert.equal(
      (
        await db.query(
          "SELECT sale_item_id FROM kb_search_documents WHERE sale_item_id='product'",
        )
      ).length,
      1,
    );
  } finally {
    await db.close();
  }
});

test("native pgvector scopes before TopK, queries embed no sources, failed jobs retry and rerank degrades explicitly", async () => {
  const calls: string[][] = [];
  let mutateDuringRerank: (() => Promise<void>) | undefined;
  let broken = false,
    rerankBroken = false;
  const provider = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(parts).toString());
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/rerank") {
      if (mutateDuringRerank) {
        const mutate = mutateDuringRerank;
        mutateDuringRerank = undefined;
        await mutate();
      }
      if (rerankBroken) {
        res.statusCode = 503;
        res.end("{}");
        return;
      }
      res.end(
        JSON.stringify({
          results: body.documents
            .map((_: string, i: number) => ({ index: i, relevance_score: i }))
            .reverse(),
        }),
      );
      return;
    }
    calls.push(body.input);
    if (broken) {
      res.statusCode = 503;
      res.end("{}");
      return;
    }
    res.end(
      JSON.stringify({
        data: body.input.map((text: string, index: number) => ({
          index,
          embedding: text.includes("视频") ? [0, 1] : [1, 0],
        })),
      }),
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const db = await openDatabase("", "memory://");
  try {
    await migrate(db);
    await db.query(
      "INSERT INTO kb_products(product_id,product_code,name,status) VALUES('p','PS','办案平台','active'),('other','ISC','安防平台','active')",
    );
    await db.query(
      "INSERT INTO kb_product_versions(product_version_id,product_id,version,status) VALUES('v','p','v1','active'),('v2','p','v2','active'),('outside','other','v1','active')",
    );
    await db.query(
      "INSERT INTO kb_sale_items(sale_item_id,product_version_id,name,specification_md,status) VALUES('s','v','出入区管理','预约审批登记','active'),('other-sale','outside','出入区管理','预约审批登记','active'),('second','v','视频监控','视频录像','active'),('different-version','v2','出入区管理','预约审批登记','active')",
    );
    const baseUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
    await saveSemanticSettings(db, {
      enabled: true,
      baseUrl,
      model: "test",
      revision: "1",
      mode: "hybrid",
      topK: 10,
      timeoutMs: 1000,
    });
    const before = await searchKnowledge(db, {
      query: "预约审批",
      mode: "vector",
      versionIds: ["v"],
    });
    assert.equal(before.index.pending, 2);
    assert.equal(
      calls.length,
      0,
      "query cannot embed source documents even on a cold index",
    );
    await refreshKnowledgeIndex(db, new AbortController().signal);
    assert.equal(
      calls.length,
      1,
      "four source documents share one embedding batch",
    );
    const countBefore = calls.length;
    const result = await searchKnowledge(db, {
      query: "预约审批",
      mode: "vector",
      versionIds: ["v"],
      topK: 1,
      minSimilarity: 0.8,
    });
    assert.equal(result.engine, "pgvector-exact");
    assert.deepEqual(
      result.results.map((r) => r.saleItemId),
      ["s"],
    );
    assert.deepEqual(calls.slice(countBefore), [["预约审批"]]);
    assert.equal(
      (
        await searchKnowledge(db, {
          query: "预约审批",
          mode: "vector",
          versionIds: ["v"],
          minSimilarity: 0.8,
        })
      ).results.length,
      1,
    );
    assert.equal(calls.length, countBefore + 1, "query vectors are cached");
    const context = {
      scopeRevision: 1,
      index: [
        {
          id: "S-test",
          sales: "出入区管理",
          product: "PS",
          version: "v1",
          category: "",
          description: "",
          capabilities: "预约审批登记",
          moduleId: "",
        },
      ],
      candidates: [
        {
          saleItemId: "s",
          path: knowledgePath(LIVE_KNOWLEDGE_ID, "sale-items", "s"),
          snapshotId: "existing-evidence",
          sales: "出入区管理",
          product: "PS",
          version: "v1",
          moduleId: "",
          excerpts: [{ lineStart: 1, lineEnd: 1, quote: "预约审批登记" }],
        },
      ],
    } as CatalogContext;
    const prepared = await prepareSemanticCatalog(
      db,
      context,
      new AbortController().signal,
    );
    const [packet] = await prepared([
      { id: "T-1", raw: "预约审批" } as RequirementInput,
    ]);
    assert.deepEqual(
      packet.candidates.map((c) => c.saleItemId),
      ["s"],
      "quick/deep assessment must use the same scoped database retrieval",
    );
    await saveRerankSettings(db, {
      enabled: true,
      baseUrl,
      model: "test-rerank",
      timeoutMs: 1000,
      candidateLimit: 10,
    });
    const reranked = await searchKnowledge(db, {
      query: "预约审批",
      mode: "vector",
      versionIds: ["v"],
      topK: 2,
    });
    assert.equal(reranked.rerank.applied, true);
    assert.equal(reranked.results[0].saleItemId, "second");
    rerankBroken = true;
    const fallback = await searchKnowledge(db, {
      query: "预约审批",
      mode: "vector",
      versionIds: ["v"],
      topK: 2,
    });
    assert.equal(fallback.rerank.applied, false);
    assert.match(fallback.warnings.join(""), /精排服务未完成/);
    rerankBroken = false;
    mutateDuringRerank = async () => {
      await db.query(
        "UPDATE kb_sale_items SET product_version_id='v2' WHERE sale_item_id='second'",
      );
      await refreshKnowledgeIndex(db, new AbortController().signal);
    };
    const concurrent = await searchKnowledge(db, {
      query: "预约审批",
      mode: "vector",
      versionIds: ["v"],
      topK: 2,
    });
    assert.ok(concurrent.results.every((r) => r.productVersionId === "v"));
    assert.ok(!concurrent.results.some((r) => r.saleItemId === "second"));
    assert.match(concurrent.warnings.join(""), /查询期间发生变化/);
    broken = true;
    await db.query(
      "UPDATE kb_sale_items SET specification_md='新增能力' WHERE sale_item_id='s'",
    );
    await refreshKnowledgeIndex(db, new AbortController().signal);
    assert.equal(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM kb_index_state WHERE sale_item_id='s'",
        )
      )[0].status,
      "failed",
    );
    assert.equal(
      (
        await searchKnowledge(db, {
          query: "新增能力",
          mode: "keyword",
          versionIds: ["v"],
        })
      ).results[0].saleItemId,
      "s",
      "keyword document remains usable when vector service fails",
    );
    const attempts = (
      await db.query<{ attempts: number }>(
        "SELECT attempts FROM kb_index_state WHERE sale_item_id='s'",
      )
    )[0].attempts;
    await refreshKnowledgeIndex(db, new AbortController().signal);
    assert.equal(
      (
        await db.query<{ attempts: number }>(
          "SELECT attempts FROM kb_index_state WHERE sale_item_id='s'",
        )
      )[0].attempts,
      attempts,
      "backoff prevents a tight retry loop",
    );
    broken = false;
    await retryKnowledgeIndex(db);
    await refreshKnowledgeIndex(db, new AbortController().signal);
    assert.equal(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM kb_index_state WHERE sale_item_id='s'",
        )
      )[0].status,
      "ready",
    );
    broken = true;
    await db.query(
      "UPDATE kb_sale_items SET specification_md='再次修改' WHERE sale_item_id='s'",
    );
    await refreshKnowledgeIndex(db, new AbortController().signal);
    await db.query(
      "UPDATE kb_index_state SET attempts=5 WHERE sale_item_id='s'",
    );
    broken = false;
    await saveSemanticSettings(db, {
      enabled: true,
      baseUrl,
      model: "test",
      revision: "2",
      mode: "hybrid",
      topK: 10,
      timeoutMs: 1000,
    });
    await refreshKnowledgeIndex(db, new AbortController().signal);
    assert.equal(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM kb_index_state WHERE sale_item_id='s'",
        )
      )[0].status,
      "ready",
      "changing model revision revives failures without manual retry",
    );
  } finally {
    await db.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
