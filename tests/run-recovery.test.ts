import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase, migrate } from "../server/db.js";
import { AppError } from "../server/errors.js";
import {
  isTransientFailure,
  scheduleRunRecovery,
} from "../server/run-recovery.js";

test("自动续跑只处理暂时故障，配置与校验错误不重试", () => {
  for (const error of [
    new Error("fetch failed"),
    new Error("socket hang up"),
    new AppError(503, "服务暂时不可用"),
    Object.assign(new Error("aborted"), { name: "TimeoutError" }),
  ])
    assert.equal(isTransientFailure(error), true);
  for (const error of [
    new AppError(401, "invalid key"),
    new AppError(422, "证据校验失败"),
    new Error("insufficient_quota"),
    new Error("model not found"),
  ])
    assert.equal(isTransientFailure(error), false);
});
test("后台恢复保留任务身份与预算，有退避，取消任务不恢复", async () => {
  const db = await openDatabase("", "memory://");
  try {
    await migrate(db);
    const uid = randomUUID(),
      pid = randomUUID(),
      cid = randomUUID(),
      id = randomUUID();
    await db.query(
      "INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,'recovery','recovery','unused','member')",
      [uid],
    );
    await db.query(
      "INSERT INTO projects(id,name,wiki_project_id,owner_id) VALUES($1,'test','wiki',$2)",
      [pid, uid],
    );
    await db.query(
      "INSERT INTO conversations(id,project_id,title) VALUES($1,$2,'test')",
      [cid, pid],
    );
    await db.query(
      "INSERT INTO runs(id,project_id,conversation_id,user_id,input,idempotency_key,status,evaluation_mode,turn_count) VALUES($1,$2,$3,$4,'test',$5,'running','quick',7)",
      [id, pid, cid, uid, randomUUID()],
    );
    const policy = { maxRecoveries: 2, delaysMs: [1000, 2000] };
    assert.equal(
      (await scheduleRunRecovery(db, id, "网络暂时不可用", policy))?.attempt,
      1,
    );
    let [run] = await db.query<{
      status: string;
      turn_count: number;
      evaluation_mode: string;
      resume_after: string;
      auto_resume_count: number;
    }>("SELECT * FROM runs WHERE id=$1", [id]);
    assert.equal(run.status, "queued");
    assert.equal(run.turn_count, 7);
    assert.equal(run.evaluation_mode, "quick");
    assert.ok(new Date(run.resume_after).getTime() > Date.now());
    assert.equal(
      await scheduleRunRecovery(db, id, "同一次异常重复处理", policy),
      null,
    );
    await db.query("UPDATE runs SET status='running' WHERE id=$1", [id]);
    assert.equal(
      (await scheduleRunRecovery(db, id, "再次断开", policy))?.attempt,
      2,
    );
    await db.query("UPDATE runs SET status='running' WHERE id=$1", [id]);
    assert.equal(
      await scheduleRunRecovery(db, id, "超过恢复上限", policy),
      null,
    );
    await db.query(
      "UPDATE runs SET status='cancelled',auto_resume_count=0 WHERE id=$1",
      [id],
    );
    assert.equal(await scheduleRunRecovery(db, id, "用户已取消", policy), null);
  } finally {
    await db.close();
  }
});
