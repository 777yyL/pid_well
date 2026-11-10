import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { openDatabase, migrate } from "../server/db.js";
import { createApp } from "../server/index.js";
import { liveKnowledge } from "../server/product-knowledge.js";
import {
  knowledgePath,
  overviewMarkdown,
} from "../server/structured-knowledge.js";
import { refreshKnowledgeIndex } from "../server/knowledge-search.js";
import { saveOverview, overviewInput } from "../server/product-overviews.js";
import { issueSession } from "../server/auth.js";
import { snapshotPage } from "../server/wiki.js";
import { createTools } from "../server/tools.js";

test("PG maintenance, project scope and all search modes work without Wiki or releases", async () => {
  const calls: string[][] = [];
  const provider = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const { input } = JSON.parse(Buffer.concat(parts).toString());
    calls.push(input);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        data: input.map((t: string, index: number) => ({
          index,
          embedding: t.includes("视频") ? [0, 1] : [1, 0],
        })),
      }),
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const db = await openDatabase("", "memory://");
  await migrate(db);
  const admin = randomUUID(),
    member = randomUUID(),
    project = randomUUID();
  await db.query(
    "INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,'admin','管理员','unused','admin'),($2,'member','成员','unused','member')",
    [admin, member],
  );
  await db.query(
    "INSERT INTO projects(id,name,wiki_project_id,owner_id) VALUES($1,'范围测试','pg',$2)",
    [project, admin],
  );
  const { app } = await createApp(db);
  const cookies: Record<string, string> = {
    admin: `workspace_session=${(await issueSession(db, admin)).token}`,
    member: `workspace_session=${(await issueSession(db, member)).token}`,
  };
  const inject = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: unknown,
    role = "admin",
  ) =>
    app.inject({
      method,
      url,
      payload: payload as any,
      headers: { cookie: cookies[role], "x-workspace-request": "1" },
    });
  const put = (kind: string, value: Record<string, unknown>, key: string) =>
    inject("PUT", `/api/knowledge/admin/${kind}/${value[key]}`, value);
  try {
    assert.equal(
      (await inject("GET", "/api/settings/rerank", undefined, "member"))
        .statusCode,
      403,
    );
    assert.equal(
      (await inject("POST", "/api/settings/rerank/test", {}, "member"))
        .statusCode,
      403,
    );
    assert.equal((await inject("GET", "/api/settings/rerank")).statusCode, 200);
    assert.equal(
      (
        await inject(
          "PUT",
          "/api/knowledge/admin/products/p",
          { product_id: "p", product_code: "PS", name: "办案平台" },
          "member",
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await put(
          "products",
          {
            product_id: "p",
            product_code: "PS",
            name: "办案平台",
            status: "active",
          },
          "product_id",
        )
      ).statusCode,
      200,
    );
    await put(
      "products",
      { product_id: "other", product_code: "ISC", name: "安防平台" },
      "product_id",
    );
    for (const [id, pid, version] of [
      ["v", "p", "v1"],
      ["v2", "p", "v2"],
      ["outside", "other", "v1"],
    ])
      await put(
        "versions",
        { product_version_id: id, product_id: pid, version },
        "product_version_id",
      );
    for (const [id, version, name, spec] of [
      ["s", "v", "人身检查", "拍照留痕"],
      ["wrong-version", "v2", "视频监控", "视频管理"],
      ["wrong-product", "outside", "视频监控", "视频管理"],
    ]) {
      const r = await put(
        "sales",
        {
          sale_item_id: id,
          product_version_id: version,
          name,
          specification_md: spec,
        },
        "sale_item_id",
      );
      assert.equal(r.statusCode, 200, r.body);
    }
    assert.equal((await db.query("SELECT * FROM kb_releases")).length, 0);
    assert.equal(
      (
        await inject("POST", "/api/knowledge/releases", {
          wikiProjectId: "unused",
          name: "不再发布",
        })
      ).statusCode,
      410,
    );
    const fresh = await inject("POST", "/api/projects", {
      name: "不需要知识库配置",
    });
    assert.equal(fresh.statusCode, 200, fresh.body);
    await db.query(
      "INSERT INTO product_scopes(project_id,status,selected) VALUES($1,'confirmed',$2)",
      [project, JSON.stringify([{ name: "PS", version: "v1", path: "" }])],
    );
    const conversation = randomUUID(),
      run = randomUUID();
    await db.query(
      "INSERT INTO conversations(id,project_id,title) VALUES($1,$2,'范围检验')",
      [conversation, project],
    );
    await db.query(
      "INSERT INTO runs(id,project_id,conversation_id,user_id,input,idempotency_key,status) VALUES($1,$2,$3,$4,'范围检验',$5,'completed')",
      [run, project, conversation, admin, randomUUID()],
    );
    await db.query(
      "UPDATE kb_sale_items SET source_path='wiki/entities/legacy-special.md' WHERE sale_item_id='wrong-product'",
    );
    const tools = createTools({
      db,
      projectId: project,
      conversationId: conversation,
      runId: run,
      userId: admin,
      emit: async () => {},
    });
    await assert.rejects(
      () =>
        tools
          .find((t) => t.name === "wiki_read")!
          .execute("scope", { path: "wiki/entities/legacy-special.md" }),
      /不属于已确认产品版本/,
    );
    await assert.rejects(
      () =>
        tools
          .find((t) => t.name === "product_search")!
          .execute("scope", { query: "视频" }),
      /产品范围已确认/,
    );
    const browse = await inject(
      "GET",
      `/api/projects/${project}/knowledge/catalog?productId=p&version=v1`,
    );
    assert.equal(browse.json().total, 1);
    const result = await inject(
      "POST",
      `/api/projects/${project}/knowledge/search`,
      { query: "人身检查", mode: "keyword", topK: 100, includeContent: true },
    );
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(
      result.json().results.map((r: any) => r.saleItemId),
      ["s"],
    );
    assert.match(result.json().results[0].content, /拍照留痕/);
    assert.equal(
      (
        await inject("POST", `/api/projects/${project}/knowledge/search`, {
          query: "视频",
          mode: "keyword",
        })
      ).json().results.length,
      0,
    );
    assert.equal(
      (
        await inject(
          "POST",
          `/api/projects/${fresh.json().id}/knowledge/search`,
          { query: "视频", mode: "keyword" },
        )
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await inject("POST", "/api/knowledge/search", {
          query: "视频",
          mode: "vector",
        })
      ).statusCode,
      409,
    );
    const port = (provider.address() as { port: number }).port;
    const saved = await inject("PUT", "/api/settings/semantic", {
      enabled: true,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "test",
      revision: "1",
      mode: "hybrid",
      topK: 10,
      minSimilarity: 0.9,
      timeoutMs: 1000,
    });
    assert.equal(saved.statusCode, 200, saved.body);
    // Index construction is a background responsibility, never part of a query.
    await refreshKnowledgeIndex(db, new AbortController().signal);
    calls.length = 0;
    for (const mode of ["vector", "hybrid"]) {
      const hit = await inject(
        "POST",
        `/api/projects/${project}/knowledge/search`,
        { query: "拍照留痕", mode, topK: 10, minSimilarity: 0.9 },
      );
      assert.equal(hit.statusCode, 200, hit.body);
      assert.deepEqual(
        hit.json().results.map((r: any) => r.saleItemId),
        ["s"],
      );
      const empty = await inject(
        "POST",
        `/api/projects/${project}/knowledge/search`,
        { query: "视频", mode, minSimilarity: 0.9 },
      );
      assert.deepEqual(empty.json().results, []);
    }
    const unlimited = await inject(
      "POST",
      `/api/projects/${project}/knowledge/search`,
      { query: "视频", mode: "vector", minSimilarity: null },
    );
    assert.equal(
      unlimited.json().results.length,
      1,
      "explicit null must clear the configured similarity threshold",
    );
    assert.ok(
      calls
        .flat()
        .every((t) => !t.includes("ISC") && !t.includes("version: v2")),
      "outside scope documents must never be embedded by project search",
    );
    const crafted = await inject(
      "POST",
      `/api/projects/${project}/knowledge/search`,
      { query: "视频", mode: "hybrid", versionIds: ["outside"] },
    );
    assert.deepEqual(crafted.json().results, []);
    await refreshKnowledgeIndex(db, new AbortController().signal);
    const index = await inject("GET", "/api/knowledge/admin/index");
    assert.equal(index.json().counts.ready, 3);
    assert.equal(index.json().missingQueue, 0);
    assert.equal(index.json().worker.status, "idle");
    const rebuild = await inject("POST", "/api/knowledge/admin/index/rebuild");
    assert.equal(rebuild.statusCode, 202, rebuild.body);
    assert.equal(rebuild.json().scheduled, 3);
    assert.match(rebuild.json().message, /关键词和向量/);
    await refreshKnowledgeIndex(db, new AbortController().signal);
    const beforeCalls = calls.length;
    await inject("POST", `/api/projects/${project}/knowledge/search`, {
      query: "拍照留痕",
      mode: "vector",
    });
    assert.equal(
      calls.length,
      beforeCalls,
      "same index and query reuse embeddings",
    );
    const evidence = await snapshotPage(
      db,
      project,
      result.json().results[0].path,
      result.json().results[0].content,
    );
    await db.query(
      "UPDATE kb_sale_items SET specification_md='新增功能' WHERE sale_item_id='s'",
    );
    assert.match(
      (
        await db.query<{ content: string }>(
          "SELECT content FROM snapshots WHERE id=$1",
          [evidence.id],
        )
      )[0].content,
      /拍照留痕/,
      "PG maintenance must not rewrite historical evidence",
    );
    assert.equal(
      (await inject("GET", "/api/knowledge/admin/index")).json().counts.pending,
      1,
    );
    const source = await liveKnowledge(db),
      input = overviewInput(source, "v");
    const overview = {
      positioning: "办案业务",
      scenarios: ["办案区"],
      modules: [
        { name: "检查", capabilities: ["拍照留痕"], saleItemIds: ["s"] },
      ],
      limitations: [],
      unspecified: ["容量待确认"],
    };
    await saveOverview(db, "v", overview, true);
    assert.match(overviewMarkdown(await liveKnowledge(db)), /支撑销售项ID：s/);
    await assert.rejects(
      () =>
        saveOverview(db, "v", {
          ...overview,
          modules: [{ ...overview.modules[0], saleItemIds: ["wrong-version"] }],
        }),
      /其他产品版本/,
    );
    await db.query(
      "UPDATE kb_sale_items SET specification_md='再更新' WHERE sale_item_id='s'",
    );
    assert.notEqual(
      overviewInput(await liveKnowledge(db), "v").hash,
      input.hash,
    );
    assert.match(overviewMarkdown(await liveKnowledge(db)), /概览待更新/);
    const path = knowledgePath(source.id, "sale-items", "s");
    const original = await inject("POST", "/api/capability/source", { path });
    assert.match(original.json().content, /再更新/);
    const graph = await inject("POST", "/api/capability/graph", {
      query: "人身检查",
      limit: 20,
    });
    assert.ok(graph.json().edges.length > 0);
    assert.equal(
      (await inject("GET", "/api/knowledge/admin/sales", undefined, "member"))
        .statusCode,
      403,
    );
  } finally {
    await app.close();
    await db.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
