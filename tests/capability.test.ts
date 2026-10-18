import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { openDatabase, migrate } from "../server/db.js";
import { createApp } from "../server/index.js";
import { issueSession } from "../server/auth.js";
import { saveSettings } from "../server/settings.js";
import { searchPaths } from "../server/capability.js";

test("能力检索兼容旧目录销售项，但不把普通产品页当销售项", () => {
  assert.deepEqual(searchPaths({ results: [
    { path: "wiki/entities/isc-acs-visitor.md", content: "---\nmodule_id: ISC-ACS-2003\n---\n# 访客管理" },
    { path: "wiki/entities/isecure-center.md", content: "# 产品页面" },
    { path: "wiki/entities/sale-items/visitor.md" },
  ] }), ["wiki/entities/isc-acs-visitor.md", "wiki/entities/sale-items/visitor.md"]);
});
import {
  validCapabilityChecks,
  capabilityStatus,
  type CapabilityCheck,
} from "../shared/capability.js";

test("能力检索：无效引用、标题引用、缺少核验点和交付条件不能判完整满足", () => {
  const check: CapabilityCheck = {
    requirement: "支持人脸通行",
    status: "supported",
    reason: "支持",
    delivery: "native",
    evidence: [{ lineStart: 5, lineEnd: 5, quote: "支持人脸通行" }],
  };
  const content = "---\ntitle: 门禁\n---\n# 门禁\n支持人脸通行";
  const valid = validCapabilityChecks([check], content);
  assert.equal(
    capabilityStatus({ membershipVerified: true, checks: valid }, [
      check.requirement,
    ]),
    "supported",
  );
  for (const evidence of [
    [{ lineStart: 2, lineEnd: 2, quote: "title: 门禁" }],
    [{ lineStart: 4, lineEnd: 4, quote: "# 门禁" }],
    [{ lineStart: 5, lineEnd: 5, quote: "支持MQTT" }],
  ]) {
    const invalid = validCapabilityChecks([{ ...check, evidence }], content);
    assert.equal(invalid[0].status, "unknown");
    assert.equal(
      capabilityStatus({ membershipVerified: true, checks: invalid }, [
        check.requirement,
      ]),
      "candidate",
    );
  }
  assert.equal(
    capabilityStatus({ membershipVerified: false, checks: valid }, [
      check.requirement,
    ]),
    "candidate",
  );
  assert.equal(
    capabilityStatus({ membershipVerified: true, checks: valid }, [
      check.requirement,
      "支持MQTT",
    ]),
    "candidate",
  );
  assert.equal(
    capabilityStatus(
      {
        membershipVerified: true,
        checks: [{ ...check, delivery: "customization" }],
      },
      [check.requirement],
    ),
    "partial",
  );
});

test("能力检索全链路：异步候选、证据核验、追问、项目候选、权限和停止", async (t) => {
  const db = await openDatabase("", "memory://");
  await migrate(db);
  const wiki = Fastify();
  const product = "wiki/entities/products/demo.md";
  const sale = "wiki/entities/sale-items/demo-acs.md";
  const content =
    "---\ntitle: 门禁管理\nproduct: Demo\nversion: v1\nmodule_id: ACS\nunit: 套\nfixed_price: 5000\n---\n支持人脸通行\n## 报价说明\n按套授权";
  const pages: Record<string, string> = {
    [product]:
      "---\ntitle: Demo\nversion: v1\n---\n[门禁管理](../sale-items/demo-acs.md)",
    [sale]: content,
    "wiki/overview.md":
      "产品标识 Demo · 产品名称 测试产品 · 所属部门 软件部 · 维护人 测试人 产品描述 门禁平台",
  };
  let broken = false;
  let fileLists = 0;
  let pageReads = 0;
  let graphReads = 0;
  let graphQuery: Record<string, string> = {};
  const modelInputs: Record<string, unknown>[] = [];
  wiki.get("/api/v1/projects", () => ({
    projects: [{ id: "wiki", name: "测试知识库" }],
  }));
  wiki.get("/api/v1/projects/:id/files", () => { fileLists++; return ({
    truncated: false,
    files: Object.keys(pages).map((path) => ({
      path: "//?/D:/company/" + path,
    })),
  }); });
  wiki.get("/api/v1/projects/:id/graph", request => { graphReads++; graphQuery = request.query as Record<string,string>; return { nodes: [{id:"sale",path:sale,label:"门禁管理"},{id:"product",path:product,label:"测试产品"}], edges: [{source:"sale",target:"product"}] }; });
  wiki.get("/api/v1/projects/:id/files/content", async (request, reply) => {
    pageReads++;
    const path = (request.query as { path: string }).path;
    return pages[path]
      ? { content: pages[path] }
      : reply.code(404).send({ ok: false });
  });
  wiki.post("/api/v1/projects/:id/search", async (request, reply) =>
    broken
      ? reply.code(503).send({ error: "unavailable" })
      : {
          results: [
            { path: sale },
            { path: "wiki/entities/versions/deleted.md" },
          ],
        },
  );
  wiki.post("/v1/chat/completions", async (request, reply) => {
    const body = request.body as {
      stream?: boolean;
      messages: { role: string; content: string }[];
    };
    const input = JSON.parse(body.messages.at(-1)!.content) as Record<
      string,
      unknown
    >;
    modelInputs.push(input);
    if (String(input.question).includes("停止测试"))
      await new Promise((r) => setTimeout(r, 200));
    const requirements = String(input.question).includes("MQTT")
      ? ["支持人脸通行", "支持MQTT"]
      : ["支持人脸通行"];
    const result = input.candidates
      ? {
          results: [
            {
              path: sale,
              checks: (input.requirements as string[]).map((requirement) => ({
                requirement,
                status: requirement.includes("MQTT") ? "unknown" : "supported",
                reason: requirement.includes("MQTT")
                  ? "资料未说明"
                  : "原文有直接依据",
                delivery: requirement.includes("MQTT") ? "unknown" : "native",
                evidence: requirement.includes("MQTT")
                  ? []
                  : [{ lineStart: 9, lineEnd: 9, quote: "支持人脸通行" }],
              })),
            },
          ],
        }
      : { requirements, queries: [requirements.join(" ")] };
    if (!body.stream)
      return {
        id: "test",
        object: "chat.completion",
        created: 1,
        model: "test",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: JSON.stringify(result) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
    reply.raw.write(
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta: { role: "assistant", content: JSON.stringify(result) }, finish_reason: null }] })}\n\n`,
    );
    reply.raw.write(
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    );
    reply.raw.end("data: [DONE]\n\n");
  });
  await wiki.listen({ host: "127.0.0.1", port: 0 });
  const port = (wiki.server.address() as { port: number }).port;
  await saveSettings(db, {
    wikiBaseUrl: `http://127.0.0.1:${port}`,
    modelBaseUrl: `http://127.0.0.1:${port}/v1`,
    model: "test-model",
    modelApiKey: "isolated-test-secret",
  });
  const userId = randomUUID(),
    otherId = randomUUID(),
    projectId = randomUUID();
  await db.query(
    "INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,'capability','测试','unused','member'),($2,'other','其它','unused','member')",
    [userId, otherId],
  );
  await db.query(
    "INSERT INTO projects(id,name,wiki_project_id,owner_id) VALUES($1,'待核实项目','wiki',$2)",
    [projectId, userId],
  );
  const { app } = await createApp(db);
  await app.ready();
  const token = await issueSession(db, userId),
    other = await issueSession(db, otherId);
  const headers = {
    "x-workspace-request": "1",
    cookie: `workspace_session=${token.token}`,
  };
  const wait = async (id: string) => {
    for (let i = 0; i < 150; i++) {
      const response = await app.inject({
        method: "GET",
        url: `/api/capability/sessions/${id}`,
        headers,
      });
      assert.equal(response.statusCode, 200, response.body);
      const value = response.json();
      if (value.status !== "running") return value;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error("检索未在测试预算内完成");
  };
  const create = async (question = "支持人脸通行") => {
    const response = await app.inject({
      method: "POST",
      url: "/api/capability/sessions",
      headers,
      payload: { wikiProjectId: "wiki", question },
    });
    assert.equal(response.statusCode, 202, response.body);
    return response.json().id as string;
  };
  try {
    await t.test("快速检索只调用搜索接口，不调用模型、文件清单、图谱或逐页读取", async () => {
      const before = [fileLists, pageReads, graphReads, modelInputs.length];
      const result = await app.inject({ method: "POST", url: "/api/capability/search", headers, payload: { wikiProjectId: "wiki", query: "人脸通行" } });
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().results[0].path, sale);
      assert.deepEqual([fileLists, pageReads, graphReads, modelInputs.length], before);
      const graph = await app.inject({ method:"POST",url:"/api/capability/graph",headers,payload:{wikiProjectId:"wiki",query:"门禁 & 通行",nodeType:"entity",limit:60} });
      assert.equal(graph.statusCode,200,graph.body);
      assert.equal(graph.json().edges.length,1);
      assert.equal(graphReads,before[2]+1);
      assert.deepEqual([fileLists,pageReads,modelInputs.length],[before[0],before[1],before[3]]);
      assert.equal(graphQuery.q,"门禁 & 通行");
      assert.equal(graphQuery.nodeType,"entity");
      assert.equal(graphQuery.limit,"60");
      const source = await app.inject({ method: "POST", url: "/api/capability/source", headers, payload: { wikiProjectId: "wiki", path: sale } });
      assert.equal(source.statusCode, 200);
      assert.equal(source.json().content, content);
      assert.equal(pageReads, before[1] + 1);
      const denied = await app.inject({ method: "POST", url: "/api/capability/search", payload: { wikiProjectId: "wiki", query: "人脸通行" } });
      assert.equal(denied.statusCode, 403); // Unauthenticated POST is rejected by CSRF before route auth.
      broken = true;
      const failed = await app.inject({ method: "POST", url: "/api/capability/search", headers, payload: { wikiProjectId: "wiki", query: "人脸通行" } });
      assert.equal(failed.statusCode, 502);
      broken = false;
    });
    const unauthorized = await app.inject({
      method: "GET",
      url: "/api/capability/sessions",
    });
    assert.equal(unauthorized.statusCode, 401);
    const id = await create();
    let session = await wait(id);
    const turn = session.data.turns[0];
    assert.equal(session.status, "completed");
    assert.equal(turn.results.length, 1);
    assert.equal(turn.results[0].status, "supported", JSON.stringify(turn));
    assert.equal(turn.results[0].membershipVerified, true);
    assert.equal(turn.results[0].owner, "测试人");
    const evidence = await app.inject({
      method: "GET",
      url: `/api/capability/sessions/${id}/pages/${turn.results[0].pageId}`,
      headers,
    });
    assert.equal(evidence.json().content, content);
    const graphUrl = `/api/capability/sessions/${id}/pages/${turn.results[0].pageId}`;
    const graph = await app.inject({ method: "GET", url: `${graphUrl}/graph`, headers });
    assert.equal(graph.statusCode, 200, graph.body);
    assert.equal(graph.json().nodes[0].path, product);
    assert.equal(graph.json().nodes[0].relation, "product");
    const related = await app.inject({ method: "GET", url: `${graphUrl}/related?path=${encodeURIComponent(product)}`, headers });
    assert.equal(related.statusCode, 200, related.body);
    assert.equal(related.json().content, pages[product]);
    const unrelated = await app.inject({ method: "GET", url: `${graphUrl}/related?path=wiki/overview.md`, headers });
    assert.equal(unrelated.statusCode, 404);
    const crossGraph = await app.inject({ method: "GET", url: `${graphUrl}/graph`, headers: { ...headers, cookie: `workspace_session=${other.token}` } });
    assert.equal(crossGraph.statusCode, 404);
    const cross = await app.inject({
      method: "GET",
      url: `/api/capability/sessions/${id}`,
      headers: { ...headers, cookie: `workspace_session=${other.token}` },
    });
    assert.equal(cross.statusCode, 404);
    const crossPage = await app.inject({
      method: "GET",
      url: `/api/capability/sessions/${id}/pages/${turn.results[0].pageId}`,
      headers: { ...headers, cookie: `workspace_session=${other.token}` },
    });
    assert.equal(crossPage.statusCode, 404);
    await t.test("候选入项目留痕，不能自动成为评估或采购项", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/capability/sessions/${id}/attach`,
        headers,
        payload: { projectId, turnId: turn.id, path: sale },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().inScope, false);
      assert.equal(
        (
          await db.query("SELECT id FROM assessments WHERE project_id=$1", [
            projectId,
          ])
        ).length,
        0,
      );
      assert.equal(
        (
          await db.query(
            "SELECT id FROM audit_log WHERE project_id=$1 AND action='finding'",
            [projectId],
          )
        ).length,
        1,
      );
      await db.query("UPDATE projects SET archived_at=now() WHERE id=$1", [
        projectId,
      ]);
      const archived = await app.inject({
        method: "POST",
        url: `/api/capability/sessions/${id}/attach`,
        headers,
        payload: { projectId, turnId: turn.id, path: sale },
      });
      assert.equal(archived.statusCode, 409);
      await db.query("UPDATE projects SET archived_at=null WHERE id=$1", [
        projectId,
      ]);
    });
    const follow = await app.inject({
      method: "POST",
      url: `/api/capability/sessions/${id}/turns`,
      headers,
      payload: { question: "还要求支持MQTT", focusPaths: [sale] },
    });
    assert.equal(follow.statusCode, 202, follow.body);
    session = await wait(id);
    assert.equal(session.data.turns.length, 2);
    assert.equal(session.data.turns[1].results[0].status, "partial");
    assert.ok(
      modelInputs.some((i) => Array.isArray(i.history) && i.history.length > 0),
    );
    const badFocus = await app.inject({
      method: "POST",
      url: `/api/capability/sessions/${id}/turns`,
      headers,
      payload: {
        question: "查看其它",
        focusPaths: ["wiki/entities/sale-items/not-found.md"],
      },
    });
    assert.equal(badFocus.statusCode, 422);
    const stopId = await create("停止测试");
    const simultaneous = await app.inject({
      method: "POST",
      url: `/api/capability/sessions/${stopId}/turns`,
      headers,
      payload: { question: "不能并发" },
    });
    assert.equal(simultaneous.statusCode, 409);
    await app.inject({
      method: "POST",
      url: `/api/capability/sessions/${stopId}/cancel`,
      headers,
      payload: {},
    });
    assert.equal((await wait(stopId)).status, "cancelled");
    broken = true;
    const failed = await wait(await create());
    assert.equal(failed.status, "failed");
    assert.match(failed.data.turns[0].error, /503/);
  } finally {
    await app.close();
    await wiki.close();
    await db.close();
  }
});
