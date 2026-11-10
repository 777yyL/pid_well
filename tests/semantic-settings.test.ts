import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { openDatabase, migrate } from "../server/db.js";
import { createApp } from "../server/index.js";
import { issueSession } from "../server/auth.js";
import { loadSemanticSettings } from "../server/semantic-settings.js";

test("语义配置仅管理员可用，密钥加密保留与清除，测试未保存连接", async () => {
  const db = await openDatabase("", "memory://");
  await migrate(db);
  const { app } = await createApp(db);
  const provider = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.url, "/v1/embeddings");
    assert.equal(input.model, "page-model");
    assert.equal(req.headers.authorization, "Bearer page-secret");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  try {
    const cookies: string[] = [];
    for (const role of ["admin", "member"]) {
      const id = randomUUID();
      await db.query(
        "INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,$2,$2,'unused',$3)",
        [id, id, role],
      );
      cookies.push(`workspace_session=${(await issueSession(db, id)).token}`);
    }
    const input = {
      enabled: true,
      baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
      model: "page-model",
      apiKey: "page-secret",
      revision: "1",
      topK: 10,
      timeoutMs: 3000,
    };
    for (const url of [
      "/api/settings/semantic",
      "/api/settings/semantic/test",
    ]) {
      const r = await app.inject({
        method: url.endsWith("test") ? "POST" : "GET",
        url,
        headers: { cookie: cookies[1], "x-workspace-request": "1" },
        ...(url.endsWith("test") ? { payload: input } : {}),
      });
      assert.equal(r.statusCode, 403);
    }
    const testResult = await app.inject({
      method: "POST",
      url: "/api/settings/semantic/test",
      headers: { cookie: cookies[0], "x-workspace-request": "1" },
      payload: input,
    });
    assert.equal(testResult.statusCode, 200, testResult.body);
    assert.equal(testResult.json().dimensions, 2);
    assert.equal(
      (await db.query("SELECT id FROM semantic_settings")).length,
      0,
      "连接测试不得保存设置",
    );
    const save = async (payload: unknown) =>
      app.inject({
        method: "PUT",
        url: "/api/settings/semantic",
        headers: { cookie: cookies[0], "x-workspace-request": "1" },
        payload: payload as never,
      });
    const result = await save(input);
    assert.equal(result.statusCode, 200, result.body);
    assert.ok(!result.body.includes("page-secret"));
    assert.equal(result.json().apiKeySet, true);
    const [stored] = await db.query<{ value: { apiKey: string } }>(
      "SELECT value FROM semantic_settings",
    );
    assert.notEqual(stored.value.apiKey, input.apiKey);
    const { apiKey, ...withoutKey } = input;
    await save(withoutKey);
    assert.equal((await loadSemanticSettings(db)).apiKey, apiKey);
    await save({ ...input, apiKey: "" });
    assert.equal((await loadSemanticSettings(db)).apiKey, "");
    const view = await app.inject({
      method: "GET",
      url: "/api/settings/semantic",
      headers: { cookie: cookies[0] },
    });
    assert.equal(view.json().apiKey, undefined);
    assert.equal(
      (await save({ ...input, baseUrl: "file:///tmp/a" })).statusCode,
      400,
    );
  } finally {
    await app.close();
    await db.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
