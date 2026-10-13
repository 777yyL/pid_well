import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase, migrate } from "../server/db.js";
import { createApp } from "../server/index.js";
import { config } from "../server/config.js";

test("公开注册与项目生命周期：权限、归档保护、完整删除和文件清理", async () => {
  const db = await openDatabase(
    "",
    await mkdtemp(resolve(tmpdir(), "project-lifecycle-")),
  );
  await migrate(db);
  const { app } = await createApp(db);
  await app.ready();
  const headers = { "x-workspace-request": "1" };
  const call = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: unknown,
    cookie = "",
  ) =>
    app.inject({
      method,
      url,
      headers: { ...headers, cookie },
      payload: payload as never,
    });
  try {
    assert.equal(
      (
        await call("POST", "/api/auth/register", {
          username: "member1",
          displayName: "成员",
          password: "test-password-123",
        })
      ).statusCode,
      409,
    );
    const setup = await call("POST", "/api/auth/setup", {
      username: "admin1",
      displayName: "管理员",
      password: "test-password-123",
    });
    const admin = String(setup.headers["set-cookie"]).split(";")[0];
    const signup = await call("POST", "/api/auth/register", {
      username: "member1",
      displayName: "成员",
      password: "test-password-123",
      role: "admin",
    });
    assert.equal(signup.statusCode, 200, signup.body);
    const member = String(signup.headers["set-cookie"]).split(";")[0];
    assert.equal(
      (await call("GET", "/api/auth/me", undefined, member)).json().user.role,
      "member",
    );
    assert.equal(
      (
        await call("POST", "/api/auth/register", {
          username: "member1",
          displayName: "成员",
          password: "test-password-123",
        })
      ).statusCode,
      409,
    );
    const id = (
      await call(
        "POST",
        "/api/projects",
        { name: "生命周期项目", wikiProjectId: "wiki-test" },
        admin,
      )
    ).json().id;
    const other = (
      await call(
        "POST",
        "/api/projects",
        { name: "保留项目", wikiProjectId: "wiki-test" },
        admin,
      )
    ).json().id;
    const me = (await call("GET", "/api/auth/me", undefined, member)).json()
      .user;
    await db.query(
      "INSERT INTO project_members(project_id,user_id) VALUES($1,$2)",
      [id, me.id],
    );
    assert.equal(
      (await call("PUT", `/api/projects/${id}`, { name: "越权修改" }, member))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await call(
          "DELETE",
          `/api/projects/${id}`,
          { name: "生命周期项目" },
          member,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await call(
          "PUT",
          `/api/projects/${id}`,
          { name: "已编辑项目", description: "新背景" },
          admin,
        )
      ).statusCode,
      200,
    );
    const conversation = (
      await call("POST", `/api/projects/${id}/conversations`, {}, admin)
    ).json().id;
    const run = randomUUID();
    const [owner] = await db.query<{ owner_id: string }>(
      "SELECT owner_id FROM projects WHERE id=$1",
      [id],
    );
    await db.query(
      "INSERT INTO runs(id,conversation_id,project_id,user_id,input,idempotency_key,status) VALUES($1,$2,$3,$4,'test',$5,'queued')",
      [run, conversation, id, owner.owner_id, randomUUID()],
    );
    assert.equal(
      (await call("POST", `/api/projects/${id}/archive`, {}, admin)).statusCode,
      409,
    );
    assert.equal(
      (
        await call(
          "DELETE",
          `/api/projects/${id}`,
          { name: "已编辑项目" },
          admin,
        )
      ).statusCode,
      409,
    );
    await db.query("UPDATE runs SET status='completed' WHERE id=$1", [run]);
    await db.query(
      "INSERT INTO messages(id,conversation_id,run_id,role,content) VALUES($1,$2,$3,'user','test')",
      [randomUUID(), conversation, run],
    );
    await db.query(
      "INSERT INTO run_events(run_id,type,payload) VALUES($1,'test','{}')",
      [run],
    );
    assert.equal(
      (await call("POST", `/api/projects/${id}/archive`, {}, admin)).statusCode,
      200,
    );
    assert.equal(
      (await call("GET", `/api/projects/${id}`, undefined, member)).statusCode,
      200,
    );
    assert.equal(
      (await call("POST", `/api/projects/${id}/conversations`, {}, admin))
        .statusCode,
      409,
    );
    assert.equal(
      (
        await call(
          "POST",
          `/api/conversations/${conversation}/runs`,
          { message: "继续", idempotencyKey: randomUUID() },
          admin,
        )
      ).statusCode,
      409,
    );
    assert.equal(
      (await call("POST", `/api/projects/${id}/restore`, {}, admin)).statusCode,
      200,
    );
    const doc = randomUUID(),
      artifact = randomUUID(),
      docFile = `${doc}.txt`,
      artifactFile = `${artifact}.html`;
    for (const [folder, file] of [
      ["uploads", docFile],
      ["artifacts", artifactFile],
    ]) {
      await mkdir(resolve(config.dataDir, folder), { recursive: true });
      await writeFile(resolve(config.dataDir, folder, file), "isolated test");
    }
    await db.query(
      "INSERT INTO documents(id,project_id,name,storage_name,hash,status) VALUES($1,$2,'test.txt',$3,'test','ready')",
      [doc, id, docFile],
    );
    await db.query(
      "INSERT INTO artifacts(id,project_id,name,storage_name,format,manifest) VALUES($1,$2,'test.html',$3,'html','{}')",
      [artifact, id, artifactFile],
    );
    await db.query(
      "INSERT INTO requirements(id,project_id,data) VALUES('T1',$1,'{}')",
      [id],
    );
    await db.query(
      "INSERT INTO assessments(id,project_id,requirement_id,data,source) VALUES($1,$2,'T1','{}','agent')",
      [randomUUID(), id],
    );
    await db.query(
      "INSERT INTO result_shares(id,project_id,created_by,token_hash,token_cipher,snapshot,artifact_ids,expires_at) VALUES($1,$2,$3,$4,'test','{}',$5,now()+interval '1 day')",
      [randomUUID(), id, owner.owner_id, randomUUID(), [artifact]],
    );
    assert.equal(
      (await call("DELETE", `/api/projects/${id}`, { name: "错误名称" }, admin))
        .statusCode,
      400,
    );
    const invalidFile = randomUUID();
    await db.query(
      "INSERT INTO artifacts(id,project_id,name,storage_name,format,manifest) VALUES($1,$2,'invalid','..','html','{}')",
      [invalidFile, id],
    );
    assert.equal(
      (
        await call(
          "DELETE",
          `/api/projects/${id}`,
          { name: "已编辑项目" },
          admin,
        )
      ).statusCode,
      500,
    );
    await access(resolve(config.dataDir, "uploads", docFile));
    await access(resolve(config.dataDir, "artifacts", artifactFile));
    assert.equal(
      (await db.query("SELECT id FROM projects WHERE id=$1", [id])).length,
      1,
    );
    await db.query("DELETE FROM artifacts WHERE id=$1", [invalidFile]);
    assert.equal(
      (
        await call(
          "DELETE",
          `/api/projects/${id}`,
          { name: "已编辑项目" },
          admin,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (await call("GET", `/api/projects/${id}`, undefined, admin)).statusCode,
      404,
    );
    assert.equal(
      (await call("GET", `/api/projects/${other}`, undefined, admin))
        .statusCode,
      200,
    );
    await assert.rejects(access(resolve(config.dataDir, "uploads", docFile)));
    await assert.rejects(
      access(resolve(config.dataDir, "artifacts", artifactFile)),
    );
    for (const table of [
      "runs",
      "conversations",
      "documents",
      "requirements",
      "assessments",
      "result_shares",
      "artifacts",
      "product_scopes",
      "project_members",
      "audit_log",
    ])
      assert.equal(
        (await db.query(`SELECT * FROM ${table} WHERE project_id=$1`, [id]))
          .length,
        0,
        table,
      );
    assert.equal(
      (
        await db.query("SELECT * FROM messages WHERE conversation_id=$1", [
          conversation,
        ])
      ).length,
      0,
    );
    assert.equal(
      (await db.query("SELECT * FROM run_events WHERE run_id=$1", [run]))
        .length,
      0,
    );
  } finally {
    await app.close();
    await db.close();
  }
});
