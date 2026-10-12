import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep, basename } from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import ExcelJS from "exceljs";
import { openDatabase, migrate } from "../server/db.js";
import { createApp } from "../server/index.js";
import { issueSession } from "../server/auth.js";
import {
  saveRequirements,
  saveAssessments,
  assessmentRows,
  checkOriginal,
} from "../server/assessment.js";
import { snapshotPage } from "../server/wiki.js";
import { createReport, safeCell } from "../server/reports.js";
import { parseDocument } from "../server/documents.js";
import { config } from "../server/config.js";
import { AgentRunner, repairTranscript } from "../server/agent.js";
import { createTools } from "../server/tools.js";
import {
  recommendProducts,
  productScope,
  enforceProductScope,
} from "../server/product-scope.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssessmentInput } from "../shared/domain.js";

test("持久化工作台：权限、证据、复核、报告和 Agent 生命周期", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tender-tests-"));
  let db = await openDatabase("", directory);
  await migrate(db);
  const { app, runner } = await createApp(db);
  await app.ready();
  const headers = { "x-workspace-request": "1" };
  const setup = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    headers,
    payload: {
      username: "test_admin",
      password: "isolated-test-password",
      displayName: "测试管理员",
    },
  });
  assert.equal(setup.statusCode, 200, setup.body);
  const cookie = String(setup.headers["set-cookie"]).split(";")[0];
  const request = (
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: unknown,
    otherCookie = cookie,
  ) =>
    app.inject({
      method,
      url,
      headers: { ...headers, cookie: otherCookie },
      payload: payload as never,
    });
  const project = await request("POST", "/api/projects", {
    name: "隔离测试项目",
    wikiProjectId: "test-wiki",
  });
  assert.equal(project.statusCode, 200, project.body);
  const projectId = project.json().id;
  const createdConversation = await request(
    "POST",
    `/api/projects/${projectId}/conversations`,
    {},
  );
  const conversationId = createdConversation.json().id;
  const documentId = randomUUID();
  const raw = "支持视频预览、录像回放和云台控制";
  await db.query(
    "INSERT INTO documents(id,project_id,name,storage_name,hash,status,lines) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      documentId,
      projectId,
      "原文.txt",
      "test.txt",
      "test",
      "ready",
      JSON.stringify([raw]),
    ],
  );
  const requirement = {
    id: "T-1",
    documentId,
    module: "视频管理",
    type: "功能" as const,
    raw,
    lineStart: 1,
    lineEnd: 1,
  };
  const overview = await snapshotPage(
    db,
    projectId,
    "wiki/overview.md",
    "产品总览",
  );
  await snapshotPage(
    db,
    projectId,
    "wiki/entities/products/test.md",
    "---\ntype: product\ntitle: 测试产品\n---\n产品导航",
  );
  const salePage =
    "---\ntype: sale-item\ntitle: 视频监控\nproduct: 测试产品\nversion: v1\nmodule_id: VMS\nunit: 套\nfixed_price: 100\n---\n## 销售项描述\n视频管理能力\n## 技术规格\n支持视频预览、录像回放和云台控制\n第二行：支持设备管理";
  await snapshotPage(
    db,
    projectId,
    "wiki/entities/sale-items/video.md",
    salePage.replace(raw, "不应导出的旧规格"),
  );
  const sale = await snapshotPage(
    db,
    projectId,
    "wiki/entities/sale-items/video.md",
    salePage,
  );
  const evidenceLine = salePage.split("\n").indexOf(raw) + 1;
  await t.test(
    "产品选择：总览证据、多选与自定义、未确认门禁、版本冲突",
    async () => {
      const [admin] = await db.query<{ id: string }>(
        "SELECT id FROM users WHERE username=$1",
        ["test_admin"],
      );
      const scope = await productScope(db, projectId);
      assert.equal(scope.status, "pending");
      await assert.rejects(
        enforceProductScope(db, projectId, {
          product: "测试产品",
          version: "v1",
        } as AssessmentInput),
        /确认推荐产品/,
      );
      const fakeRun = randomUUID();
      await db.query(
        "INSERT INTO runs(id,conversation_id,project_id,user_id,input,idempotency_key,status) VALUES($1,$2,$3,$4,'推荐产品',$5,'completed')",
        [fakeRun, conversationId, projectId, admin.id, randomUUID()],
      );
      await assert.rejects(
        recommendProducts(
          db,
          projectId,
          [
            {
              name: "测试产品",
              version: "v1",
              path: "wiki/entities/products/test.md",
              reason: "符合清单视频管理方向，可进一步检查规格",
              coverage: "视频管理",
              gaps: "需要逐条核验",
              evidence: [
                { snapshotId: sale.id, lineStart: 1, lineEnd: 1, quote: "---" },
              ],
            },
          ],
          fakeRun,
        ),
        /总览/,
      );
      const recommendations = await recommendProducts(
        db,
        projectId,
        [
          {
            name: "测试产品",
            version: "v1",
            path: "wiki/entities/products/test.md",
            reason: "符合清单视频管理方向，可进一步检查规格",
            coverage: "视频管理",
            gaps: "需要逐条核验",
            evidence: [
              {
                snapshotId: overview.id,
                lineStart: 1,
                lineEnd: 1,
                quote: "产品总览",
              },
            ],
          },
        ],
        fakeRun,
      );
      assert.equal(recommendations.status, "pending");
      const choose = {
        expectedRevision: recommendations.revision,
        selected: [
          {
            name: "测试产品",
            version: "v1",
            path: "wiki/entities/products/test.md",
          },
          { name: "自定义备用产品", version: "v2", path: "" },
        ],
        strategy: "优先已有平台",
      };
      const confirmed = await request(
        "PUT",
        `/api/projects/${projectId}/product-scope`,
        choose,
      );
      assert.equal(confirmed.statusCode, 200, confirmed.body);
      assert.equal(confirmed.json().selected.length, 2);
      assert.equal(
        (
          await request(
            "PUT",
            `/api/projects/${projectId}/product-scope`,
            choose,
          )
        ).statusCode,
        409,
      );
      await assert.rejects(
        recommendProducts(
          db,
          projectId,
          recommendations.recommendations,
          fakeRun,
        ),
        /不能覆盖/,
      );
    },
  );
  const item: AssessmentInput = {
    requirementId: "T-1",
    sales: ["视频监控"],
    product: "测试产品",
    version: "v1",
    level: "exact",
    ok: ["视频预览", "录像回放", "云台控制"],
    hard: [],
    no: [],
    note: "三个子能力逐项对应",
    criteria: {
      direction: "方向一致",
      scope: "三个子能力全部覆盖",
      spec: "原文无额外硬指标",
      context: "适用视频管理场景",
      delivery: "无额外依赖",
    },
    evidence: [
      {
        snapshotId: sale.id,
        lineStart: evidenceLine,
        lineEnd: evidenceLine,
        quote: raw,
      },
    ],
    dependencies: [],
    mustSelect: [],
  };

  await t.test("认证、CSRF、成员授权及项目越权", async () => {
    assert.equal((await app.inject("/api/projects")).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: { name: "x" },
          headers: { cookie },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/logout",
          headers: { ...headers, cookie, origin: "https://other.example" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await request("POST", "/api/auth/setup", {
          username: "second_admin",
          password: "isolated-test-password",
        })
      ).statusCode,
      409,
    );
    await request("POST", "/api/users", {
      username: "test_member",
      password: "isolated-test-password",
      displayName: "测试成员",
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers,
      payload: { username: "test_member", password: "isolated-test-password" },
    });
    const memberCookie = String(login.headers["set-cookie"]).split(";")[0];
    assert.equal(
      (
        await request(
          "GET",
          `/api/projects/${projectId}`,
          undefined,
          memberCookie,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (await request("PUT", "/api/settings", {}, memberCookie)).statusCode,
      403,
    );
    const users = await request("GET", "/api/users");
    const member = users
      .json()
      .find((u: { username: string }) => u.username === "test_member");
    await request("POST", `/api/projects/${projectId}/members`, {
      userId: member.id,
    });
    assert.equal(
      (
        await request(
          "GET",
          `/api/projects/${projectId}`,
          undefined,
          memberCookie,
        )
      ).statusCode,
      200,
    );
  });
  await t.test("原文校验、人工确认、证据及正式报告门禁", async () => {
    assert.throws(
      () => checkOriginal({ ...requirement, raw: "支持全部视频功能" }, [raw]),
      /逐字引用/,
    );
    await saveRequirements(db, projectId, [requirement], null);
    await saveRequirements(db, projectId, [requirement], null);
    await assert.rejects(
      () => saveAssessments(db, projectId, [item], {}),
      /尚未确认/,
    );
    assert.equal(
      (
        await request("POST", `/projects/${projectId}/requirements/confirm`, {
          ids: ["T-1"],
        })
      ).statusCode,
      404,
    );
    const confirmation = await request(
      "POST",
      `/api/projects/${projectId}/requirements/confirm`,
      { ids: ["T-1"] },
    );
    assert.equal(confirmation.statusCode, 200, confirmation.body);
    await assert.rejects(
      () =>
        saveAssessments(
          db,
          projectId,
          [
            {
              ...item,
              evidence: [{ ...item.evidence[0], quote: "伪造的能力" }],
            },
          ],
          {},
        ),
      /摘录或行号/,
    );
    await assert.rejects(
      () =>
        saveAssessments(db, projectId, [{ ...item, sales: ["组件 vms"] }], {}),
      /正式实体页/,
    );
    await saveAssessments(db, projectId, [item], {});
    await assert.rejects(
      () =>
        saveAssessments(
          db,
          projectId,
          [{ ...item, product: "不在选择范围的产品" }],
          {},
        ),
      /确认范围/,
    );
    await assert.rejects(
      () => enforceProductScope(db, projectId, { ...item, version: "v99" }),
      /确认范围/,
    );
    const foreign = await snapshotPage(
      db,
      projectId,
      "wiki/entities/sale-items/foreign.md",
      salePage.replace("product: 测试产品", "product: 未选择的第三方产品"),
    );
    await assert.rejects(
      () =>
        enforceProductScope(db, projectId, {
          ...item,
          evidence: [{ ...item.evidence[0], snapshotId: foreign.id }],
        }),
      /所属产品/,
    );
    const selected = await productScope(db, projectId);
    assert.equal(
      (
        await request("PUT", `/api/projects/${projectId}/product-scope`, {
          expectedRevision: selected.revision,
          selected: [{ name: "其它产品", version: "", path: "" }],
          strategy: "",
        })
      ).statusCode,
      409,
    );
    await assert.rejects(() => createReport(db, projectId, "xlsx"), /已复核/);
    const rows = await assessmentRows(db, projectId);
    assert.equal(rows[0].reviewed, false);
    const update = await request(
      "PUT",
      `/api/projects/${projectId}/assessments/T-1`,
      {
        assessment: { ...item, note: "人工核验了三个子能力与销售项原文" },
        expectedRevision: 1,
      },
    );
    assert.equal(update.statusCode, 200, update.body);
    assert.equal(
      (
        await request("PUT", `/api/projects/${projectId}/assessments/T-1`, {
          assessment: item,
          expectedRevision: 1,
        })
      ).statusCode,
      409,
    );
    await assert.rejects(
      () => saveAssessments(db, projectId, [item], {}),
      /不可被 Agent 覆盖/,
    );
  });
  await t.test(
    "报告从同一份复核结果生成，保存版本证据并防止公式注入",
    async () => {
      const report = await createReport(db, projectId, "xlsx");
      const [record] = await db.query<{
        storage_name: string;
        manifest: { requirements: { revision: number }[] };
      }>("SELECT storage_name,manifest FROM artifacts WHERE id=$1", [
        report.id,
      ]);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(
        resolve(config.dataDir, "artifacts", record.storage_name),
      );
      assert.equal(workbook.worksheets.length, 3);
      assert.equal(
        workbook.worksheets[0].getRow(2).getCell(10).value,
        "人工核验了三个子能力与销售项原文",
      );
      assert.equal(
        workbook.worksheets[1].getRow(2).getCell(5).value,
        raw + "\n第二行：支持设备管理",
      );
      assert.equal(record.manifest.requirements[0].revision, 2);
      const standalone = await request(
        "POST",
        `/api/projects/${projectId}/reports`,
        { format: "xlsx", kind: "sales" },
      );
      assert.equal(standalone.statusCode, 200, standalone.body);
      const standaloneBook = new ExcelJS.Workbook();
      const [standaloneRecord] = await db.query<{ storage_name: string }>(
        "SELECT storage_name FROM artifacts WHERE id=$1",
        [standalone.json().id],
      );
      await standaloneBook.xlsx.readFile(
        resolve(config.dataDir, "artifacts", standaloneRecord.storage_name),
      );
      assert.equal(standaloneBook.worksheets[0].name, "销售项清单");
      assert.deepEqual(
        Array.from(
          { length: 10 },
          (_, i) => standaloneBook.worksheets[0].getRow(1).getCell(i + 1).value,
        ),
        [
          "序号",
          "名称",
          "产品类别",
          "型号",
          "技术规格",
          "单位",
          "数量",
          "单价",
          "合价",
          "备注",
        ],
      );
      assert.equal(
        standaloneBook.worksheets[0].getRow(2).getCell(8).value,
        100,
      );
      assert.equal(
        standaloneBook.worksheets[0].getRow(2).getCell(7).value,
        null,
      );
      assert.equal(standaloneBook.worksheets[0].columnCount, 10);
      assert.equal(safeCell('=HYPERLINK("evil")'), '\'=HYPERLINK("evil")');
      const html = await createReport(db, projectId, "html");
      assert.equal((await request("GET", html.url)).statusCode, 200);
      const csv = await createReport(db, projectId, "csv");
      assert.equal((await request("GET", csv.url)).statusCode, 200);
      await saveAssessments(
        db,
        projectId,
        [{ ...item, dependencies: ["尚未列入的必选基础包"] }],
        { human: true },
      );
      await assert.rejects(
        () => createReport(db, projectId, "xlsx"),
        /缺少交付依赖/,
      );
      await saveAssessments(db, projectId, [item], { human: true });
    },
  );
  await t.test("解析多表 Excel、文本及明确的格式错误", async () => {
    assert.deepEqual(await parseDocument("input.txt", Buffer.from(raw)), [raw]);
    await assert.rejects(
      () => parseDocument("input.doc", Buffer.from(raw)),
      /请先转换/,
    );
    await assert.rejects(
      () => parseDocument("empty.txt", Buffer.from("  ")),
      /有效文本/,
    );
    const book = new ExcelJS.Workbook();
    book.addWorksheet("Sheet1").addRow(["名称", "参数"]);
    book.addWorksheet("Sheet2").addRow(["系统", raw]);
    const lines = await parseDocument(
      "input.xlsx",
      Buffer.from(await book.xlsx.writeBuffer()),
    );
    assert(lines.some((l) => l.includes("Sheet2")));
    assert(lines.some((l) => l.includes(raw)));
  });
  const provider = Fastify();
  const received: Record<string, unknown>[] = [];
  provider.post("/v1/chat/completions", async (request, reply) => {
    const body = request.body as {
      messages: { role: string; content: unknown; tool_calls?: unknown[] }[];
    };
    received.push(body);
    const last = body.messages.at(-1)!;
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    const send = (delta: unknown, finish: string | null = null) =>
      reply.raw.write(
        `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    const userContent = [...body.messages]
      .reverse()
      .find((m) => m.role === "user")?.content;
    const userText =
      typeof userContent === "string"
        ? userContent
        : JSON.stringify(userContent);
    if (
      body.messages.some(
        (m) =>
          m.role === "system" && String(m.content).includes("工作记录压缩器"),
      )
    ) {
      send(
        {
          role: "assistant",
          content:
            "已完成项目读取和计划保存。继续查询已保存结果，不覆盖人工确认。",
        },
        "stop",
      );
      reply.raw.end("data: [DONE]\n\n");
      return;
    }
    if (
      userText.includes("慢任务") ||
      body.messages.some(
        (m) =>
          m.role === "user" &&
          JSON.stringify(m.content).includes("超时保护测试"),
      )
    ) {
      send({ role: "assistant", content: "" });
      const timer = setTimeout(() => {
        send({ content: "迟到的回复" }, "stop");
        reply.raw.end("data: [DONE]\n\n");
      }, 10000);
      reply.raw.on("close", () => clearTimeout(timer));
      return;
    }
    send({ role: "assistant", content: "" });
    if (
      userText.includes("兼容恢复测试") ||
      body.messages.some(
        (m) =>
          m.role === "user" &&
          JSON.stringify(m.content).includes("持续协议错误测试"),
      )
    ) {
      send(
        {
          content:
            '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="save_requirements">未执行的调用文本</｜｜DSML｜｜ invoke>',
        },
        "stop",
      );
      reply.raw.end("data: [DONE]\n\n");
      return;
    }
    if (
      body.messages.some(
        (m) =>
          m.role === "user" && JSON.stringify(m.content).includes("空回复测试"),
      )
    ) {
      send({ content: "" }, "stop");
      reply.raw.end("data: [DONE]\n\n");
      return;
    }
    if (userText.includes("循环无进展")) {
      send(
        {
          tool_calls: [
            {
              index: 0,
              id: `repeat_${received.length}`,
              type: "function",
              function: { name: "project_context", arguments: "{}" },
            },
          ],
        },
        "tool_calls",
      );
      reply.raw.end("data: [DONE]\n\n");
      return;
    }
    if (userText.includes("总预算测试")) {
      send(
        {
          tool_calls: [
            {
              index: 0,
              id: `progress_${received.length}`,
              type: "function",
              function: {
                name: "update_plan",
                arguments: JSON.stringify({
                  steps: [
                    {
                      id: "p",
                      title: `新进展 ${received.length}`,
                      status: "running",
                    },
                  ],
                }),
              },
            },
          ],
        },
        "tool_calls",
      );
      reply.raw.end("data: [DONE]\n\n");
      return;
    }
    if (userText.includes("模拟输出截断")) {
      send({ reasoning_content: "仅有推理，还未输出结果" }, "length");
      reply.raw.end("data: [DONE]\n\n");
      return;
    }
    if (last.role === "user" && userText.includes("规划")) {
      send({
        tool_calls: [
          {
            index: 0,
            id: "call_project",
            type: "function",
            function: { name: "project_context", arguments: "{}" },
          },
        ],
      });
      send({}, "tool_calls");
    } else if (
      last.role === "tool" &&
      body.messages.some(
        (m) =>
          m.tool_calls &&
          JSON.stringify(m.tool_calls).includes("project_context"),
      ) &&
      !body.messages.some(
        (m) =>
          m.tool_calls && JSON.stringify(m.tool_calls).includes("update_plan"),
      )
    ) {
      send({
        tool_calls: [
          {
            index: 0,
            id: "call_plan",
            type: "function",
            function: {
              name: "update_plan",
              arguments: JSON.stringify({
                steps: [
                  { id: "1", title: "读取项目与要求", status: "done" },
                  { id: "2", title: "说明评估结果", status: "done" },
                ],
              }),
            },
          },
        ],
      });
      send({}, "tool_calls");
    } else {
      send({ content: "已读取项目并保留评估上下文。" }, "stop");
    }
    reply.raw.end("data: [DONE]\n\n");
  });
  await provider.listen({ host: "127.0.0.1", port: 0 });
  const port = (provider.server.address() as { port: number }).port;
  const saved = await request("PUT", "/api/settings", {
    modelBaseUrl: `http://127.0.0.1:${port}/v1`,
    model: "test-model",
    modelApiKey: "test-secret-key",
    wikiBaseUrl: "http://127.0.0.1:19828",
    contextWindow: 64000,
    maxOutputTokens: 4096,
    requireRequirementConfirmation: true,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const [stored] = await db.query<{ value: { modelApiKey: string } }>(
    "SELECT value FROM settings WHERE id=1",
  );
  assert(!stored.value.modelApiKey.includes("test-secret-key"));
  assert(!saved.body.includes("test-secret-key"));
  await runner.start();
  async function waitRun(
    id: string,
    states: string[] = ["completed", "failed", "interrupted", "cancelled"],
  ) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const [run] = await db.query<{ status: string; error: string }>(
        "SELECT status,error FROM runs WHERE id=$1",
        [id],
      );
      if (states.includes(run.status)) return run;
      await new Promise((r) => setTimeout(r, 50));
    }
    const [state] = await db.query(
      "SELECT status,error,turn_count FROM runs WHERE id=$1",
      [id],
    );
    throw new Error(`等待执行超时 ${JSON.stringify(state)}`);
  }
  await t.test(
    "真实 Pi 循环连接兼容 SSE 模型、规划工具、多轮上下文、幂等和取消",
    async () => {
      const payload = {
        message: "请规划并读取项目",
        idempotencyKey: randomUUID(),
      };
      const first = await request(
        "POST",
        `/api/conversations/${conversationId}/runs`,
        payload,
      );
      assert.equal(first.statusCode, 200, first.body);
      const runId = first.json().id;
      const duplicate = await request(
        "POST",
        `/api/conversations/${conversationId}/runs`,
        payload,
      );
      assert.equal(duplicate.json().id, runId);
      const result = await waitRun(runId);
      assert.equal(result.status, "completed", result.error);
      const events = await request("GET", `/api/runs/${runId}/events`);
      assert(
        events
          .json()
          .events.some((e: { type: string }) => e.type === "plan_updated"),
        JSON.stringify(events.json().events),
      );
      assert(
        events
          .json()
          .events.some(
            (e: { type: string; payload: { stage?: string } }) =>
              e.type === "context_compaction" &&
              e.payload.stage === "completed",
          ),
      );
      const [checkpoint] = await db.query<{
        checkpoint: { summary: string; compressions: number };
      }>("SELECT checkpoint FROM conversations WHERE id=$1", [conversationId]);
      assert(checkpoint.checkpoint.compressions > 0);
      assert(checkpoint.checkpoint.summary.includes("人工确认"));
      const follow = await request(
        "POST",
        `/api/conversations/${conversationId}/runs`,
        { message: "上一轮的项目是什么？", idempotencyKey: randomUUID() },
      );
      assert.equal((await waitRun(follow.json().id)).status, "completed");
      assert(JSON.stringify(received.at(-1)).includes("请规划并读取项目"));
      const slow = await request(
        "POST",
        `/api/conversations/${conversationId}/runs`,
        { message: "慢任务", idempotencyKey: randomUUID() },
      );
      await waitRun(slow.json().id, ["running"]);
      const conflict = await request(
        "POST",
        `/api/conversations/${conversationId}/runs`,
        { message: "重复执行", idempotencyKey: randomUUID() },
      );
      assert.equal(conflict.statusCode, 409);
      await request("POST", `/api/runs/${slow.json().id}/cancel`);
      assert.equal((await waitRun(slow.json().id)).status, "cancelled");
    },
  );
  await t.test(
    "错误工具文本自动恢复；持续协议错误、空回复和模型超时可恢复中断",
    async () => {
      for (const [message, status, retryCount] of [
        ["兼容恢复测试", "completed", 1],
        ["持续协议错误测试", "interrupted", 2],
        ["空回复测试", "interrupted", 2],
        ["超时保护测试", "interrupted", 2],
      ] as const) {
        const created = await request(
          "POST",
          `/api/projects/${projectId}/conversations`,
        );
        const id = created.json().id;
        const response = await request(
          "POST",
          `/api/conversations/${id}/runs`,
          { message, idempotencyKey: randomUUID() },
        );
        const runId = response.json().id;
        const result = await waitRun(runId);
        assert.equal(result.status, status, `${message}: ${result.error}`);
        const events = await db.query<{
          type: string;
          payload: Record<string, unknown>;
        }>("SELECT type,payload FROM run_events WHERE run_id=$1 ORDER BY id", [
          runId,
        ]);
        assert.equal(
          events.filter((e) => e.type === "run_retry").length,
          retryCount,
        );
        assert(
          !events.some(
            (e) =>
              e.type === "tool_execution_start" &&
              e.payload.toolName === "save_requirements",
          ),
        );
        const history = await request(
          "GET",
          `/api/conversations/${id}/messages`,
        );
        assert(
          !history.body.includes("DSML"),
          "错误工具文本不可作为普通回复保存",
        );
        const progress = events.filter((e) => e.type === "run_progress");
        assert(progress.length > 0);
        assert.equal(typeof progress[0].payload.requirements, "number");
        if (message === "超时保护测试") {
          assert.match(result.error, /超时/);
          assert(progress.length >= 3, "等待模型期间仍应定时发送状态");
        }
      }
    },
  );
  await t.test("自动续跑保留无进展保护和任务总预算", async () => {
    for (const [message, reason] of [
      ["循环无进展", "未取得进展"],
      ["总预算测试", "总执行预算"],
    ]) {
      const response = await request(
        "POST",
        `/api/conversations/${conversationId}/runs`,
        { message, idempotencyKey: randomUUID() },
      );
      const run = await waitRun(response.json().id);
      assert.equal(run.status, "interrupted");
      assert(run.error?.includes(reason), run.error);
    }
  });
  await t.test("仅有推理的截断响应标记为可恢复中断，不误报完成", async () => {
    const response = await request(
      "POST",
      `/api/conversations/${conversationId}/runs`,
      {
        message: "模拟输出截断",
        idempotencyKey: randomUUID(),
      },
    );
    const result = await waitRun(response.json().id);
    assert.equal(result.status, "interrupted");
    assert.match(result.error!, /输出上限/);
    const tool = createTools({
      db,
      projectId,
      conversationId,
      runId: response.json().id,
      userId: randomUUID(),
      emit: async () => {},
    }).find((t) => t.name === "save_requirements")!;
    await tool.execute("span", {
      requirements: [
        {
          id: "T-999",
          documentId,
          lineStart: 1,
          lineEnd: 1,
          type: "功能",
          module: "视频",
        },
      ],
    });
    const [saved] = await db.query<{ data: { raw: string } }>(
      "SELECT data FROM requirements WHERE project_id=$1 AND id='T-999'",
      [projectId],
    );
    const [doc] = await db.query<{ lines: string[] }>(
      "SELECT lines FROM documents WHERE id=$1",
      [documentId],
    );
    assert.equal(saved.data.raw, doc.lines[0]);
    await assert.rejects(
      tool.execute("oversized", {
        requirements: Array(11).fill({
          id: "T-998",
          documentId,
          lineStart: 1,
          lineEnd: 1,
          type: "功能",
          module: "视频",
        }),
      }),
    );
    const lookup = createTools({
      db,
      projectId,
      conversationId,
      runId: response.json().id,
      userId: randomUUID(),
      emit: async () => {},
    }).find((t) => t.name === "get_assessments")!;
    const data = await lookup.execute("lookup", {
      ids: ["T-1"],
      unreviewed: false,
    });
    const lookupText = data.content.find((p) => p.type === "text");
    assert(lookupText?.type === "text");
    const value = JSON.parse(lookupText.text);
    assert.equal(value.assessments.length, 1);
    assert.equal(value.assessments[0].requirementId, "T-1");
    assert.equal(value.assessments[0].source, "human");
    const empty = await assessmentRows(db, projectId, 50, 0, {
      ids: ["T-1"],
      unreviewed: true,
    });
    assert.equal(empty.length, 0);
  });
  await app.close();
  await provider.close();
  await t.test(
    "服务重启标记中断，修补未完成工具调用而不重复执行写入",
    async () => {
      const interruptedId = randomUUID();
      const [user] = await db.query<{ id: string }>(
        "SELECT id FROM users WHERE username='test_admin'",
      );
      await db.query(
        "INSERT INTO runs(id,conversation_id,project_id,user_id,input,idempotency_key,status) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          interruptedId,
          conversationId,
          projectId,
          user.id,
          "模拟崩溃前任务",
          randomUUID(),
          "running",
        ],
      );
      const restarted = new AgentRunner(db);
      await restarted.start();
      const [run] = await db.query<{ status: string }>(
        "SELECT status FROM runs WHERE id=$1",
        [interruptedId],
      );
      assert.equal(run.status, "interrupted");
      await restarted.close();
      const [conversation] = await db.query<{ context: AgentMessage[] }>(
        "SELECT context FROM conversations WHERE id=$1",
        [conversationId],
      );
      const assistant = conversation.context.find(
        (m) =>
          m.role === "assistant" &&
          m.content.some((p) => p.type === "toolCall"),
      )!;
      const repaired = repairTranscript([assistant]);
      assert.equal(repaired[1].role, "toolResult");
      assert(repaired[1].role === "toolResult" && repaired[1].isError);
    },
  );
  await t.test(
    "同一公司代理下不同登录用户独立限流，超额用户仍受限制",
    async () => {
      const { app: rateApp } = await createApp(db);
      await rateApp.ready();
      const users = await db.query<{ id: string }>(
        "SELECT id FROM users WHERE username IN ('test_admin','test_member') ORDER BY username",
      );
      const sessions = await Promise.all(
        users.map((user) => issueSession(db, user.id)),
      );
      try {
        for (let index = 0; index < 300; index++) {
          const response = await rateApp.inject({
            url: "/api/health",
            headers: { cookie: `workspace_session=${sessions[0].token}` },
          });
          assert.equal(response.statusCode, 200);
        }
        const blocked = await rateApp.inject({
          url: "/api/health",
          headers: { cookie: `workspace_session=${sessions[0].token}` },
        });
        assert.equal(blocked.statusCode, 429);
        assert.match(blocked.json().error, /服务端继续/);
        const other = await rateApp.inject({
          url: "/api/health",
          headers: { cookie: `workspace_session=${sessions[1].token}` },
        });
        assert.equal(other.statusCode, 200, "同 IP 另一用户不应被连带限流");
      } finally {
        await rateApp.close();
      }
    },
  );
  await t.test("修改密码撤销旧登录会话", async () => {
    const { app: authApp } = await createApp(db);
    await authApp.ready();
    const changed = await authApp.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { ...headers, cookie },
      payload: {
        currentPassword: "isolated-test-password",
        newPassword: "updated-isolated-test-password",
      },
    });
    assert.equal(changed.statusCode, 200, changed.body);
    const old = await authApp.inject({
      url: "/api/projects",
      headers: { cookie },
    });
    assert.equal(old.statusCode, 401);
    await authApp.close();
  });
  await db.close();
  await t.test("关闭并重新打开数据库后会话、证据和人工结果仍在", async () => {
    db = await openDatabase("", directory);
    const [row] = await db.query<{ source: string }>(
      "SELECT source FROM assessments WHERE project_id=$1",
      [projectId],
    );
    assert.equal(row.source, "human");
    const [conversation] = await db.query<{ context: unknown[] }>(
      "SELECT context FROM conversations WHERE id=$1",
      [conversationId],
    );
    assert(conversation.context.length > 0);
    await db.close();
  });
  const target = resolve(directory);
  assert(
    target.startsWith(resolve(tmpdir()) + sep) &&
      basename(target).startsWith("tender-tests-"),
  );
  await rm(target, { recursive: true, force: true });
});
