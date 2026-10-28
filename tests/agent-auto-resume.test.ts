import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { openDatabase, migrate } from "../server/db.js";
import { AgentRunner } from "../server/agent.js";
import { saveAgentSettings } from "../server/settings.js";

test("真实网络故障耗尽即时重试后，后台续跑同一任务并完成；重启排队可以取消", async () => {
  const db = await openDatabase("", "memory://");
  let runner: AgentRunner | undefined;
  const uid = randomUUID(),
    pid = randomUUID(),
    cid = randomUUID(),
    id = randomUUID();
  const provider = createServer(async (req, res) => {
    for await (const _ of req) {
      /* drain JSON body */
    }
    const [run] = await db.query<{ auto_resume_count: number }>(
      "SELECT auto_resume_count FROM runs WHERE id=$1",
      [id],
    );
    if (!run.auto_resume_count) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "temporary network failure", type: "server_error" },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: unknown, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: "recovery", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.end(
      chunk(
        { role: "assistant", content: "连接已恢复，继续处理完成。" },
        null,
      ) +
        chunk({}, "stop") +
        "data: [DONE]\n\n",
    );
  });
  try {
    await migrate(db);
    await db.query(
      "INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,'resume','resume','unused','member')",
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
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    await saveAgentSettings(db, uid, {
      model: "test-model",
      modelApiKey: "test-only-key",
      modelBaseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
    });
    await db.query(
      "INSERT INTO runs(id,project_id,conversation_id,user_id,input,idempotency_key,status) VALUES($1,$2,$3,$4,'请回复收到',$5,'queued')",
      [id, pid, cid, uid, randomUUID()],
    );
    runner = new AgentRunner(db, {
      maxRecoveries: 1,
      delaysMs: [5],
      maxTotalTurns: 8,
    });
    await runner.start();
    let row:
      | { status: string; auto_resume_count: number; turn_count: number }
      | undefined;
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      [row] = await db.query(
        "SELECT status,auto_resume_count,turn_count,error FROM runs WHERE id=$1",
        [id],
      );
      if (row?.status === "completed") break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(row?.status, "completed", JSON.stringify(row));
    assert.equal(row.auto_resume_count, 1);
    assert.ok(row.turn_count > 1 && row.turn_count <= 8);
    const events = await db.query<{ type: string; payload: { kind?: string } }>(
      "SELECT type,payload FROM run_events WHERE run_id=$1",
      [id],
    );
    assert.ok(
      events.some((e) => e.type === "run_retry" && e.payload.kind === "resume"),
    );
    await runner.close();
    runner = undefined;
    const restartId = randomUUID();
    await db.query(
      "INSERT INTO runs(id,project_id,conversation_id,user_id,input,idempotency_key,status) VALUES($1,$2,$3,$4,'模拟重启',$5,'running')",
      [restartId, pid, cid, uid, randomUUID()],
    );
    runner = new AgentRunner(db, { maxRecoveries: 1, delaysMs: [10000] });
    await runner.start();
    const [restarted] = await db.query<{
      status: string;
      auto_resume_count: number;
    }>("SELECT status,auto_resume_count FROM runs WHERE id=$1", [restartId]);
    assert.equal(restarted.status, "queued");
    assert.equal(restarted.auto_resume_count, 1);
    await runner.cancel(restartId);
    const [cancelled] = await db.query<{ status: string }>(
      "SELECT status FROM runs WHERE id=$1",
      [restartId],
    );
    assert.equal(cancelled.status, "cancelled");
  } finally {
    await runner?.close();
    await new Promise<void>((r) => provider.close(() => r()));
    await db.close();
  }
});
