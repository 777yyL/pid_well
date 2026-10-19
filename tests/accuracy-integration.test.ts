import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrate, audit } from "../server/db.js";
import { snapshotPage } from "../server/wiki.js";
import {
  saveRequirements,
  saveAssessments,
  assessmentRows,
  supplementSubrequirements,
  validateVerification,
} from "../server/assessment.js";
import { saveCoverage, sourceCoverage } from "../server/source-coverage.js";
import { createTools } from "../server/tools.js";
import { collectSales, summarizeSales } from "../server/sale-entity.js";
import { captureReport, createReport } from "../server/reports.js";
import { renderReportHtml } from "../server/report-layout.js";
import type { AssessmentInput, RequirementInput } from "../shared/domain.js";

test("准确性全链路：组合证据、未知、补查、自检、原文漏项及历史兼容", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "accuracy-isolated-"));
  const db = await openDatabase("", dir);
  try {
    await migrate(db);
    const userId = randomUUID(),
      projectId = randomUUID(),
      docId = randomUUID(),
      conversationId = randomUUID(),
      runId = randomUUID();
    await db.query(
      "INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,'accuracy','测试','unused','admin')",
      [userId],
    );
    await db.query(
      "INSERT INTO projects(id,name,wiki_project_id,owner_id) VALUES($1,'合成项目','synthetic',$2)",
      [projectId, userId],
    );
    await db.query(
      "INSERT INTO conversations(id,project_id,title) VALUES($1,$2,'测试')",
      [conversationId, projectId],
    );
    await db.query(
      "INSERT INTO runs(id,project_id,conversation_id,user_id,input,idempotency_key,status) VALUES($1,$2,$3,$4,'test',$5,'completed')",
      [runId, projectId, conversationId, userId, randomUUID()],
    );
    await db.query(
      "INSERT INTO documents(id,project_id,name,storage_name,hash,status,lines) VALUES($1,$2,'合成原文','unused','synthetic','ready',$3)",
      [
        docId,
        projectId,
        JSON.stringify(["支持事件触发并广播播报", "支持 MQTT"]),
      ],
    );
    const requirement: RequirementInput = {
      id: "T-1",
      documentId: docId,
      module: "联动",
      type: "功能",
      raw: "支持事件触发并广播播报",
      lineStart: 1,
      lineEnd: 1,
      subrequirements: [
        {
          id: "T-1.1",
          raw: "事件触发",
          required: true,
          lineStart: 1,
          lineEnd: 1,
        },
        {
          id: "T-1.2",
          raw: "广播播报",
          required: true,
          lineStart: 1,
          lineEnd: 1,
        },
      ],
    };
    await saveRequirements(db, projectId, [requirement], null);
    await db.query(
      "UPDATE requirements SET confirmed=true WHERE project_id=$1",
      [projectId],
    );
    await snapshotPage(db, projectId, "wiki/overview.md", "A / B");
    for (const p of ["A", "B"])
      await snapshotPage(
        db,
        projectId,
        `wiki/entities/products/${p}.md`,
        `---\ntitle: ${p}\nversion: v1\n---\n[同名销售项](../sale-items/${p}.md)`,
      );
    const snapshots = await Promise.all(
      ["A", "B"].map((p) =>
        snapshotPage(
          db,
          projectId,
          `wiki/entities/sale-items/${p}.md`,
          `---\ntitle: 同名销售项\nproduct: ${p}\nversion: v1\nmodule_id: ${p}\n---\n支持${p === "A" ? "事件触发" : "广播播报"}\n支持 MQTT 事件向广播推送，v1 兼容，配置连接，接口授权`,
        ),
      ),
    );
    await db.query(
      "INSERT INTO product_scopes(project_id,status,selected) VALUES($1,'confirmed',$2)",
      [
        projectId,
        JSON.stringify(
          ["A", "B"].map((name) => ({
            name,
            version: "v1",
            path: `wiki/entities/products/${name}.md`,
          })),
        ),
      ],
    );
    const proof = (i: number) => ({
      snapshotId: snapshots[i].id,
      lineStart: 7,
      lineEnd: 7,
      quote: `支持${i ? "广播播报" : "事件触发"}`,
    });
    const item: AssessmentInput = {
      requirementId: "T-1",
      product: "A",
      version: "v1",
      sales: ["同名销售项"],
      level: "exact",
      ok: ["触发", "播报"],
      hard: [],
      no: [],
      note: "组合交付",
      criteria: {
        direction: "提供",
        scope: "两项",
        spec: "无",
        context: "校园",
        delivery: "接口联动",
      },
      evidence: [proof(0), proof(1)],
      dependencies: [],
      mustSelect: [],
      verification: {
        version: 2,
        checks: [0, 1].map((i) => ({
          subrequirementId: `T-1.${i + 1}`,
          level: "exact",
          direction: "提供",
          reason: "原文明确支持",
          delivery: "integration",
          deliveryConfirmed: true,
          evidence: [proof(i)],
        })),
        contributions: [0, 1].map((i) => ({
          id: i ? "B" : "A",
          product: i ? "B" : "A",
          version: "v1",
          sales: "同名销售项",
          moduleId: i ? "B" : "A",
          path: `wiki/entities/sale-items/${i ? "B" : "A"}.md`,
          capability: i ? "播报" : "触发",
          subrequirementIds: [`T-1.${i + 1}`],
          purpose: "purchase",
          reason: "明确新增需求",
          evidence: [proof(i)],
        })),
        integrationRequired: true,
        integrations: [
          {
            from: "A",
            to: "B",
            protocol: "MQTT",
            direction: "事件向广播推送",
            compatibility: "v1",
            configuration: "配置连接",
            authorization: "接口授权",
            confirmed: true,
            evidence: [
              {
                snapshotId: snapshots[0].id,
                lineStart: 8,
                lineEnd: 8,
                quote: "支持 MQTT 事件向广播推送，v1 兼容，配置连接，接口授权",
              },
            ],
          },
        ],
        supplementalSearch: [],
        counterchecks: {
          direction: "提供方",
          omissions: "两项齐全",
          quantitative: "无",
          external: "已查",
          integration: "双方接口证据",
        },
      },
    };
    const copy = () => structuredClone(item);
    await t.test("缺少子要求、标题、跨版本与接口条件门禁", async () => {
      const missing = copy();
      missing.verification!.checks.pop();
      await assert.rejects(
        () => saveAssessments(db, projectId, [missing], {}),
        /全部子要求/,
      );
      const title = copy();
      title.verification!.checks[0].evidence = [
        { ...proof(0), lineStart: 2, lineEnd: 2, quote: "title: 同名销售项" },
      ];
      await assert.rejects(
        () => saveAssessments(db, projectId, [title], {}),
        /标题或元数据/,
      );
      const version = copy();
      const orphan = copy();
      orphan.verification!.contributions[1].purpose = "dependency";
      await assert.rejects(
        () => saveAssessments(db, projectId, [orphan], {}),
        /正式依赖/,
      );
      version.verification!.contributions[1].version = "v2";
      await assert.rejects(
        () => saveAssessments(db, projectId, [version], {}),
        /版本不在/,
      );
      const cross = copy();
      cross.verification!.integrations[0].confirmed = false;
      await assert.rejects(
        () => saveAssessments(db, projectId, [cross], {}),
        /顶层结论/,
      );
      await saveAssessments(db, projectId, [item], {});
      const pages = await db.query<{
        id: string;
        path: string;
        content: string;
        hash: string;
      }>("SELECT * FROM snapshots WHERE project_id=$1", [projectId]);
      assert.deepEqual(
        collectSales([item], pages)
          .map((s) => s.entity.product)
          .sort(),
        ["A", "B"],
      );
      const existing = copy();
      existing.verification!.contributions[0].purpose = "existing";
      assert.deepEqual(
        collectSales([existing], pages).map((s) => s.entity.product),
        ["B"],
      );
      const reuse = copy();
      reuse.verification!.contributions[1].purpose = "existing";
      reuse.verification!.contributions[1].reuseOf = "A";
      reuse.verification!.contributions[1].reason =
        "已核实主产品提供共享组件授权";
      await validateVerification(db, projectId, reuse, requirement);
      const procurement = summarizeSales([reuse], pages);
      assert.deepEqual(
        procurement.sales.map((s) => s.entity.product),
        ["A"],
      );
      assert.equal(procurement.reused[0].product, "B");
      assert.match(procurement.reused[0].source, /A v1/);
      const unconfirmed = structuredClone(reuse);
      unconfirmed.verification!.integrations[0].confirmed = false;
      await assert.rejects(
        () => validateVerification(db, projectId, unconfirmed, requirement),
        /共享|复用/,
      );
      const circular = structuredClone(reuse);
      circular.verification!.contributions[1].reuseOf = "B";
      await assert.rejects(
        () => validateVerification(db, projectId, circular, requirement),
        /循环复用/,
      );
    });
    await t.test(
      "未知必须逐子要求补查；AI 自检不能消除未知或冒充人工",
      async () => {
        const unknown = copy();
        unknown.level = "unknown";
        unknown.sales = [];
        unknown.verification!.checks[1].level = "unknown";
        unknown.verification!.checks[1].evidence = [];
        unknown.verification!.integrations[0].confirmed = false;
        await assert.rejects(
          () => saveAssessments(db, projectId, [unknown], {}),
          /补充检索/,
        );
        const traceId = await audit(
          db,
          projectId,
          null,
          runId,
          "product_scoped_search",
          {
            requirementId: "T-1",
            subrequirementId: "T-1.2",
            query: "补查播报",
            scopeRevision: 1,
            matchCount: 0,
          },
        );
        unknown.verification!.supplementalSearch = [
          {
            subrequirementId: "T-1.2",
            query: "补查播报",
            outcome: "未找到明确能力说明",
            traceId,
          },
        ];
        await saveAssessments(db, projectId, [unknown], {});
        const review = createTools({
          db,
          projectId,
          conversationId,
          runId,
          userId,
          emit: async () => {},
        }).find((t) => t.name === "review_assessments")!;
        const input = {
          requirementId: "T-1",
          revision: 2,
          checks: item.criteria,
          coverageConfirmed: true,
          reason: "逐子要求自检仍有接口和能力未知",
        };
        await assert.rejects(
          () => review.execute("test", { reviews: [input] }),
          /逐子要求/,
        );
        await review.execute("test", {
          reviews: [
            {
              ...input,
              points: [
                {
                  subrequirementId: "T-1.1",
                  evidenceIndexes: [0],
                  gap: "",
                  explanation: "明确触发",
                },
                {
                  subrequirementId: "T-1.2",
                  evidenceIndexes: [],
                  gap: "能力未说明",
                  explanation: "未知保留",
                },
              ],
            },
          ],
        });
        const [saved] = await assessmentRows(db, projectId);
        assert.equal(saved.level, "unknown");
        assert.equal(saved.source, "agent");
        assert.equal(saved.reviewed, true);
        assert.deepEqual(collectSales([saved], []), []);
        const report = await captureReport(db, projectId);
        assert.equal(report.sourceCoverage[0].status, "unchecked");
        const html = renderReportHtml(report, "synthetic");
        assert.match(html, /待确认/);
        assert.match(html, /AI 自检完成/);
        assert.match(html, /未检查 2 行/);
        for (const format of ["html", "csv", "xlsx"] as const)
          await createReport(db, projectId, format, "full", report);
        await assert.rejects(
          () =>
            review.execute("test", { reviews: [{ ...input, revision: 1 }] }),
          /逐子要求|版本/,
        );
      },
    );
    await t.test("原文遗漏仍待检查，人工记录保护，历史记录不升级", async () => {
      assert.equal(
        (await sourceCoverage(db, projectId))[0].status,
        "unchecked",
      );
      const value = {
        documentId: docId,
        entries: [
          {
            id: "item-1",
            lineStart: 1,
            lineEnd: 1,
            status: "extracted",
            reason: "技术条款",
            requirementIds: ["T-1"],
            subrequirementIds: ["T-1.1", "T-1.2"],
          },
        ],
      };
      const result = await saveCoverage(db, projectId, value, { userId });
      assert.equal(result[0].status, "pending");
      assert.deepEqual(result[0].uncheckedLines, [2]);
      await assert.rejects(
        () => saveCoverage(db, projectId, value, { runId }),
        /人工原文覆盖/,
      );
      const old = { ...item, evidence: [proof(0)], verification: undefined };
      await db.query(
        "UPDATE assessments SET data=$1,source='human' WHERE project_id=$2",
        [JSON.stringify(old), projectId],
      );
      assert.equal(
        (await assessmentRows(db, projectId))[0].verification,
        undefined,
      );
      await assert.rejects(
        () => saveAssessments(db, projectId, [item], {}),
        /人工确认结果/,
      );
      await saveAssessments(db, projectId, [{ ...old, note: "历史人工修订" }], {
        human: true,
        userId,
      });
      assert.equal(
        (await assessmentRows(db, projectId))[0].verification,
        undefined,
      );
    });
    await t.test(
      "历史已确认条款显式补全：逐字核验、并发保护、人工结果保留",
      async () => {
        const legacy: RequirementInput = {
          id: "T-3",
          documentId: docId,
          module: "协议",
          type: "接口",
          raw: "支持 MQTT",
          lineStart: 2,
          lineEnd: 2,
        };
        await saveRequirements(db, projectId, [legacy], null);
        await db.query(
          "UPDATE requirements SET confirmed=true WHERE project_id=$1 AND id='T-3'",
          [projectId],
        );
        const original = {
          note: "已有人工结论，不能自动升级",
          verification: undefined,
        };
        await db.query(
          "INSERT INTO assessments(id,project_id,requirement_id,data,source,reviewed) VALUES($1,$2,'T-3',$3,'human',true)",
          [randomUUID(), projectId, JSON.stringify(original)],
        );
        const sub = {
          id: "T-3.1",
          raw: "MQTT",
          required: true,
          lineStart: 2,
          lineEnd: 2,
        };
        await assert.rejects(
          supplementSubrequirements(db, projectId, "T-3", userId, {
            expectedSubrequirements: null,
            subrequirements: [{ ...sub, raw: "支持 HTTPS" }],
          }),
          /逐字/,
        );
        await assert.rejects(
          supplementSubrequirements(db, projectId, "T-3", userId, {
            expectedSubrequirements: null,
            subrequirements: [{ ...sub, lineStart: 1 }],
          }),
          /逐字/,
        );
        const updated = await supplementSubrequirements(
          db,
          projectId,
          "T-3",
          userId,
          { expectedSubrequirements: null, subrequirements: [sub] },
        );
        assert.equal(updated.raw, legacy.raw);
        assert.equal(updated.confirmed, true);
        assert.deepEqual(updated.subrequirements, [sub]);
        await assert.rejects(
          supplementSubrequirements(db, projectId, "T-3", userId, {
            expectedSubrequirements: null,
            subrequirements: [sub],
          }),
          /已更新/,
        );
        await assert.rejects(
          supplementSubrequirements(db, projectId, "T-3", userId, {
            expectedSubrequirements: [sub],
            subrequirements: [{ ...sub, required: false }],
          }),
          /不能替换/,
        );
        const [assessment] = await db.query<{
          data: unknown;
          source: string;
          reviewed: boolean;
        }>(
          "SELECT data,source,reviewed FROM assessments WHERE project_id=$1 AND requirement_id='T-3'",
          [projectId],
        );
        assert.deepEqual(assessment.data, JSON.parse(JSON.stringify(original)));
        assert.equal(assessment.source, "human");
        assert.equal(assessment.reviewed, true);
      },
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
