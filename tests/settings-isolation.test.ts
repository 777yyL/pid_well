import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrate } from "../server/db.js";
import { createApp } from "../server/index.js";
import {
  loadSettings,
  saveSettings,
  saveAgentSettings,
} from "../server/settings.js";

test("个人Agent配置隔离、知识库仅管理员维护、新项目不能覆盖默认知识库", async () => {
  const db = await openDatabase(
    "",
    await mkdtemp(join(tmpdir(), "settings-isolation-")),
  );
  await migrate(db);
  const { app, runner } = await createApp(db);
  const provider = Fastify();
  const call = (
    method: "GET" | "PUT" | "POST",
    url: string,
    cookie = "",
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: { cookie, "x-workspace-request": "1" },
      payload: payload as never,
    });
  try {
    const adminResult = await call("POST", "/api/auth/setup", "", {
      username: "admin",
      password: "isolated-password-123",
    });
    const admin = String(adminResult.headers["set-cookie"]).split(";")[0];
    const aResult = await call("POST", "/api/auth/register", "", {
      username: "member_a",
      displayName: "A",
      password: "isolated-password-123",
    });
    const a = String(aResult.headers["set-cookie"]).split(";")[0];
    const bResult = await call("POST", "/api/auth/register", "", {
      username: "member_b",
      displayName: "B",
      password: "isolated-password-123",
    });
    const b = String(bResult.headers["set-cookie"]).split(";")[0];
    assert.equal((await call("GET", "/api/settings")).statusCode, 401);
    assert.equal((await call("GET", "/api/settings/wiki", a)).statusCode, 403);
    assert.equal(
      (
        await call("PUT", "/api/settings/wiki", a, {
          defaultWikiProjectId: "evil",
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await call("POST", "/api/settings/test", a, { target: "wiki" }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await call("POST", "/api/projects", a, {
          name: "未配置",
          wikiProjectId: "evil",
        })
      ).statusCode,
      422,
    );
    const wiki = await call("PUT", "/api/settings/wiki", admin, {
      wikiBaseUrl: "http://127.0.0.1:19828",
      wikiToken: "global-wiki-secret",
      defaultWikiProjectId: "central",
    });
    assert.equal(wiki.statusCode, 200, wiki.body);
    assert.ok(!wiki.body.includes("global-wiki-secret"));
    const personal = await call("PUT", "/api/settings", a, {
      model: "model-a",
      modelBaseUrl: "http://127.0.0.1:9123/v1",
      modelApiKey: "private-a",
      contextWindow: 128000,
      maxOutputTokens: 4096,
    });
    assert.equal(personal.statusCode, 200, personal.body);
    assert.ok(!personal.body.includes("private-a"));
    assert.ok(!personal.body.includes("wikiBaseUrl"));
    assert.equal((await call("GET", "/api/settings", b)).json().model, "");
    assert.equal((await call("GET", "/api/settings", admin)).json().model, "");
    assert.equal(
      (
        await call("PUT", "/api/settings", a, {
          userId: randomUUID(),
          model: "override",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await call("PUT", "/api/settings", a, { wikiToken: "override" }))
        .statusCode,
      400,
    );
    await call("PUT", "/api/settings", a, { model: "model-a-updated" });
    const aId = (await call("GET", "/api/auth/me", a)).json().user.id;
    const aConfig = await loadSettings(db, aId);
    assert.equal(aConfig.modelApiKey, "private-a");
    assert.equal(aConfig.modelBaseUrl, "http://127.0.0.1:9123/v1");
    assert.equal(aConfig.contextWindow, 128000);
    await call("PUT", "/api/settings", b, {
      model: "model-b",
      modelApiKey: "private-b",
    });
    assert.equal(
      (await call("GET", "/api/settings", a)).json().model,
      "model-a-updated",
    );
    const stored = await db.query<{ value: { modelApiKey: string } }>(
      "SELECT value FROM user_agent_settings",
    );
    assert.ok(
      stored.every(
        (r) => !["private-a", "private-b"].includes(r.value.modelApiKey),
      ),
    );
    const created = await call("POST", "/api/projects", a, {
      name: "自动绑定",
      wikiProjectId: "evil",
    });
    assert.equal(created.statusCode, 200, created.body);
    const projectId = created.json().id;
    assert.equal(
      (await call("GET", `/api/projects/${projectId}`, a)).json().project
        .wiki_project_id,
      "central",
    );
    await call("PUT", "/api/settings/wiki", admin, {
      defaultWikiProjectId: "central-new",
    });
    assert.equal((await loadSettings(db)).wikiToken, "global-wiki-secret");
    assert.equal(
      (await call("GET", `/api/projects/${projectId}`, a)).json().project
        .wiki_project_id,
      "central",
    );
    const next = await call("POST", "/api/projects", b, { name: "新项目" });
    assert.equal(
      (await call("GET", `/api/projects/${next.json().id}`, b)).json().project
        .wiki_project_id,
      "central-new",
    );
    // A collaborator without personal settings must never borrow the project owner's model.
    await call("POST", `/api/projects/${projectId}/members`, admin, {
      userId: (await call("GET", "/api/auth/me", admin)).json().user.id,
    });
    const conversation = await call(
      "POST",
      `/api/projects/${projectId}/conversations`,
      a,
      {},
    );
    const rejected = await call(
      "POST",
      `/api/conversations/${conversation.json().id}/runs`,
      admin,
      { message: "测试", idempotencyKey: randomUUID() },
    );
    assert.equal(rejected.statusCode, 422);
    assert.match(rejected.body, /个人 Agent 配置/);
    const received: { key: string; model: string }[] = [];
    provider.post("/v1/chat/completions", async (request, reply) => {
      const body = request.body as { model: string };
      received.push({
        key: String(request.headers.authorization),
        model: body.model,
      });
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      reply.raw.write(
        `data: ${JSON.stringify({ id: "local-test", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\n`,
      );
      reply.raw.end(
        `data: ${JSON.stringify({ id: "local-test", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    });
    await provider.listen({ host: "127.0.0.1", port: 0 });
    const port = (provider.server.address() as { port: number }).port;
    await call("PUT", "/api/settings", a, {
      modelBaseUrl: `http://127.0.0.1:${port}/v1`,
    });
    await call("PUT", "/api/settings", b, {
      modelBaseUrl: `http://127.0.0.1:${port}/v1`,
    });
    const connected = await call("POST", "/api/settings/test", a, {
      target: "model",
    });
    assert.equal(connected.statusCode, 200, connected.body);
    assert.deepEqual(received.at(-1), {
      key: "Bearer private-a",
      model: "model-a-updated",
    });
    const bId = (await call("GET", "/api/auth/me", b)).json().user.id;
    await call("POST", `/api/projects/${projectId}/members`, admin, {
      userId: bId,
    });
    const run = await call(
      "POST",
      `/api/conversations/${conversation.json().id}/runs`,
      b,
      { message: "只回复OK", idempotencyKey: randomUUID() },
    );
    assert.equal(run.statusCode, 200, run.body);
    await runner.start();
    let status = "queued";
    for (let i = 0; i < 100; i++) {
      const [row] = await db.query<{ status: string }>(
        "SELECT status FROM runs WHERE id=$1",
        [run.json().id],
      );
      status = row.status;
      if (!["queued", "running"].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(status, "completed");
    assert.deepEqual(
      received.at(-1),
      { key: "Bearer private-b", model: "model-b" },
      "共享项目的任务必须使用发起人的模型与密钥",
    );
  } finally {
    await app.close();
    await provider.close();
    await db.close();
  }
});

test("升级只将旧全局模型迁给首个管理员，且不覆盖个人设置", async () => {
  const db = await openDatabase(
    "",
    await mkdtemp(join(tmpdir(), "settings-migration-")),
  );
  try {
    await migrate(db);
    const admin = randomUUID(),
      member = randomUUID();
    await db.query(
      "INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,'admin','admin','unused','admin'),($2,'member','member','unused','member')",
      [admin, member],
    );
    await saveSettings(db, { model: "old-model", modelApiKey: "old-secret" });
    await db.query(
      "INSERT INTO projects(id,name,wiki_project_id,owner_id) VALUES($1,'旧项目','old-wiki',$2)",
      [randomUUID(), admin],
    );
    await db.query("UPDATE settings SET value=value-'defaultWikiProjectId'");
    await db.query("DELETE FROM schema_migrations WHERE version=6");
    await migrate(db);
    assert.equal((await loadSettings(db, admin)).modelApiKey, "old-secret");
    const [global] = await db.query<{ value: Record<string, unknown> }>(
      "SELECT value FROM settings WHERE id=1",
    );
    assert.equal("modelApiKey" in global.value, false);
    assert.equal((await loadSettings(db, member)).modelApiKey, "");
    assert.equal((await loadSettings(db)).defaultWikiProjectId, "old-wiki");
    await saveAgentSettings(db, admin, { model: "personal-model" });
    await migrate(db);
    assert.equal((await loadSettings(db, admin)).model, "personal-model");
  } finally {
    await db.close();
  }
});
