import { WikiClient } from "../server/wiki.js";
import { runQuickAssessment } from "../server/quick-assessment.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createReport } from "../server/reports.js";
import { createHash, randomUUID } from "node:crypto";
import { openDatabase, migrate } from "../server/db.js";
import { createTools } from "../server/tools.js";
import {
  projectKnowledge,
  knowledgePath,
  saleMarkdown,
} from "../server/structured-knowledge.js";
import {
  searchSelected,
  prepareSelectedSearch,
  validateCatalogSale,
  searchGlobalFallback,
  recordAlternative,
} from "../server/product-search.js";
import { selectProducts } from "../server/product-scope.js";
import { saveAssessments, assessmentRows } from "../server/assessment.js";
import { summarizeSales, parseSaleEntity } from "../server/sale-entity.js";
import type {
  KnowledgeData,
  KnowledgeRelease,
} from "../shared/product-knowledge.js";
import type { AssessmentInput } from "../shared/domain.js";

test("结构化评估：固定发布、按版本检索、稳定ID入库和采购汇总，历史项目不切换", async () => {
  const db = await openDatabase("", "memory://");
  const originalSearch = WikiClient.prototype.search;
  const scopes: string[][] = [];
  WikiClient.prototype.search = async (_id, _query, _topK, _content, paths) => {
    assert.ok(paths, "published retrieval must prefilter Wiki by source paths");
    scopes.push(paths);
    return {
      scopeApplied: true,
      results: paths.map((path) => ({
        path,
        score: 0.8,
        content: "UNTRUSTED LIVE CONTENT",
      })),
    };
  };
  try {
    await migrate(db);
    const uid = randomUUID(),
      pid = randomUUID(),
      cid = randomUUID(),
      rid = randomUUID(),
      doc = randomUUID();
    await db.query(
      "INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,'structured','结构化测试','unused','admin')",
      [uid],
    );
    await db.query(
      "INSERT INTO projects(id,name,wiki_project_id,owner_id) VALUES($1,'结构化测试','structured',$2)",
      [pid, uid],
    );
    await db.query(
      "INSERT INTO conversations(id,project_id,title) VALUES($1,$2,'测试')",
      [cid, pid],
    );
    await db.query(
      "INSERT INTO runs(id,project_id,conversation_id,user_id,input,idempotency_key,status) VALUES($1,$2,$3,$4,'test',$5,'completed')",
      [rid, pid, cid, uid, randomUUID()],
    );
    await db.query(
      "INSERT INTO documents(id,project_id,name,storage_name,hash,status,lines) VALUES($1,$2,'视频子系统','unused','unused','ready','[\"支持实时预览\"]')",
      [doc, pid],
    );
    await db.query(
      "INSERT INTO requirements(id,project_id,data,confirmed) VALUES('T-1',$1,$2,true),('T-2',$1,$3,true)",
      [
        pid,
        ...["T-1", "T-2"].map((id) =>
          JSON.stringify({
            id,
            documentId: doc,
            module: "视频",
            type: "功能",
            raw: "支持实时预览",
            lineStart: 1,
            lineEnd: 1,
            subrequirements: [
              {
                id: id + ".1",
                raw: "实时预览",
                lineStart: 1,
                lineEnd: 1,
                required: true,
              },
            ],
          }),
        ),
      ],
    );
    await db.query(
      "INSERT INTO public.kb_products(product_id,product_code,name,status) VALUES('p','产品A','产品名称','active')",
    );
    await db.query(
      "INSERT INTO public.kb_product_versions(product_version_id,product_id,version,status) VALUES('v1','p','v1','active'),('v2','p','v2','active')",
    );
    await db.query(
      "INSERT INTO public.kb_sale_items(sale_item_id,product_version_id,module_code,name,specification_md,unit,price_type,fixed_price,currency,status,source_path) VALUES('s1','v1','VIDEO','视频监控','支持实时预览','套','fixed',5000,'CNY','active','wiki/entities/sale-items/video-v1.md'),('s2','v2','VIDEO','视频监控','支持实时预览','套','fixed',7000,'CNY','active','wiki/entities/sale-items/video-v2.md')",
    );
    const data: KnowledgeData = {
      products: await db.query("SELECT * FROM public.kb_products"),
      versions: await db.query("SELECT * FROM public.kb_product_versions"),
      categories: [],
      saleItems: await db.query("SELECT * FROM public.kb_sale_items"),
      dependencies: [],
    };
    const releaseId = randomUUID();
    await db.query(
      "INSERT INTO public.kb_releases(id,wiki_project_id,name,data,created_by) VALUES($1,'structured','首版',$2,$3)",
      [releaseId, JSON.stringify(data), uid],
    );
    const tools = createTools({
      db,
      projectId: pid,
      conversationId: cid,
      runId: rid,
      userId: uid,
      emit: async () => {},
    });
    const overview = tools.find((t) => t.name === "wiki_overview")!;
    await overview.execute("overview", {});
    const pinned = await projectKnowledge(db, pid);
    assert.equal(pinned?.id, releaseId);
    const nextId = randomUUID(),
      next = structuredClone(data);
    next.saleItems[0].fixed_price = 9999;
    await db.query(
      "INSERT INTO public.kb_releases(id,wiki_project_id,name,data,created_by,created_at) VALUES($1,'structured','第二版',$2,$3,now()+interval '1 second')",
      [nextId, JSON.stringify(next), uid],
    );
    assert.equal((await projectKnowledge(db, pid, true))?.id, releaseId);
    await selectProducts(db, pid, uid, {
      expectedRevision: 1,
      selected: [{ name: "产品A", version: "v1", path: "" }],
      strategy: "",
    });
    let modelCalls = 0;
    const prepared = await prepareSelectedSearch(db, pid, rid);
    let rebuilt = 0;
    const instrumented = {
      ...db,
      query: async <T>(sql: string, args?: unknown[]) => {
        if (sql.includes("INSERT INTO snapshots")) rebuilt++;
        return db.query<T>(sql, args);
      },
    };
    await searchSelected(
      instrumented,
      pid,
      rid,
      "T-1",
      "实时预览",
      3,
      undefined,
      "T-1.1",
      undefined,
      prepared,
    );
    await searchSelected(
      instrumented,
      pid,
      rid,
      "T-2",
      "实时预览",
      3,
      undefined,
      "T-2.1",
      undefined,
      prepared,
    );
    assert.equal(rebuilt, 2, "两次检索只写销售项快照，不再重建产品目录快照");
    await assert.rejects(
      searchSelected(
        db,
        pid,
        randomUUID(),
        "T-1",
        "实时预览",
        3,
        undefined,
        "T-1.1",
        undefined,
        prepared,
      ),
      /不属于当前任务/,
    );
    await db.query(
      "UPDATE product_scopes SET revision=revision+1 WHERE project_id=$1",
      [pid],
    );
    await assert.rejects(
      searchSelected(
        db,
        pid,
        rid,
        "T-1",
        "实时预览",
        3,
        undefined,
        "T-1.1",
        undefined,
        prepared,
      ),
      /范围已变化/,
    );
    await db.query(
      "UPDATE product_scopes SET revision=$1 WHERE project_id=$2",
      [prepared.catalog.scopeRevision, pid],
    );
    const progress: Record<string, unknown>[] = [];
    const judge = async (
      packets: import("../server/quick-assessment.js").QuickPacket[],
    ) => {
      modelCalls++;
      return JSON.stringify({
        assessments: packets.map((p) => {
          const c = p.candidates[0];
          const text = c.excerpts.map((e) => e.quote).join("\n");
          const snapshot = text
            .split("\n")
            .findIndex((l) => l === "支持实时预览");
          assert.ok(snapshot >= 0);
          const line = c.excerpts[0].lineStart + snapshot;
          return {
            requirementId: p.requirement.id,
            selections: [
              {
                candidateIndex: 0,
                purpose: "purchase",
                reason: "支持实时预览",
              },
            ],
            checks: [
              {
                subrequirementId: p.requirement.subrequirements![0].id,
                level: "exact",
                direction: "实时预览",
                reason: "技术规格明确支持实时预览",
                delivery: "native",
                deliveryConfirmed: true,
                evidence: [
                  {
                    candidateIndex: 0,
                    lineStart: line,
                    lineEnd: line,
                    quote: "支持实时预览",
                  },
                ],
              },
            ],
          };
        }),
      });
    };
    assert.equal(
      await runQuickAssessment(
        db,
        pid,
        rid,
        new AbortController().signal,
        judge,
        async (p) => {
          progress.push(p);
        },
      ),
      true,
    );
    assert.equal(modelCalls, 1);
    const quickRows = await assessmentRows(db, pid);
    assert.equal(quickRows.length, 2);
    assert.ok(quickRows.every((r) => !r.reviewed));
    await runQuickAssessment(
      db,
      pid,
      rid,
      new AbortController().signal,
      judge,
      async () => {},
    );
    assert.equal(
      modelCalls,
      1,
      "resume must not call model for already saved current-scope rows",
    );
    assert.equal(progress.at(-1)?.saved, 2);
    assert.ok(
      progress.some((p) => p.judged === 2 && p.saved === 0),
      "模型完成计数必须先于保存完成",
    );
    await db.query(
      "DELETE FROM assessments WHERE project_id=$1 AND requirement_id='T-2'",
      [pid],
    );
    const feedbacks: (string | undefined)[] = [];
    const repairProgress: Record<string, unknown>[] = [];
    await runQuickAssessment(
      db,
      pid,
      rid,
      new AbortController().signal,
      async (packets, feedback) => {
        feedbacks.push(feedback);
        const value = JSON.parse(await judge(packets));
        if (feedbacks.length === 1)
          value.assessments[0].checks[0].evidence[0].quote = "伪造的原文";
        return JSON.stringify(value);
      },
      async (p) => {
        repairProgress.push(p);
      },
    );
    assert.equal(feedbacks.length, 2);
    assert.ok(feedbacks[1], "保存校验错误应反馈给第二次模型调用");
    assert.equal(repairProgress.at(-1)?.judged, 1, "重试不重复累计已判断条款");
    const errors = repairProgress.at(-1)?.failures as {
      stage: string;
      message: string;
    }[];
    assert.ok(
      errors.some((e) => e.stage === "保存校验" && e.message),
      "重试成功后仍保留失败详情",
    );
    await db.query(
      "UPDATE assessments SET source='human',reviewed=true WHERE project_id=$1 AND requirement_id='T-1'",
      [pid],
    );
    await db.query(
      "DELETE FROM assessments WHERE project_id=$1 AND requirement_id='T-2'",
      [pid],
    );
    let failedCalls = 0;
    await assert.rejects(
      runQuickAssessment(
        db,
        pid,
        rid,
        new AbortController().signal,
        async () => {
          failedCalls++;
          throw new Error("模拟模型暂时不可用");
        },
        async () => {},
      ),
      /1 条初评未完成/,
    );
    assert.equal(failedCalls, 2, "bounded retry");
    assert.equal(
      (await assessmentRows(db, pid)).length,
      1,
      "failed batch must not erase saved results",
    );
    await runQuickAssessment(
      db,
      pid,
      rid,
      new AbortController().signal,
      judge,
      async () => {},
    );
    assert.equal(modelCalls, 4, "only unsaved clause rejudged");
    assert.equal(
      (await assessmentRows(db, pid)).find((r) => r.requirementId === "T-1")
        ?.source,
      "human",
    );
    const cancelled = new AbortController();
    cancelled.abort();
    await db.query(
      "DELETE FROM assessments WHERE project_id=$1 AND requirement_id='T-2'",
      [pid],
    );
    await assert.rejects(
      runQuickAssessment(db, pid, rid, cancelled.signal, judge, async () => {}),
    );
    assert.equal(modelCalls, 4, "cancel must not call model");
    await db.query("DELETE FROM assessments WHERE project_id=$1", [pid]);
    const result = await searchSelected(
      db,
      pid,
      rid,
      "T-1",
      "实时预览",
      5,
      undefined,
      "T-1.1",
    );
    assert.equal(result.results.length, 1);
    assert.deepEqual(scopes[0], ["wiki/entities/sale-items/video-v1.md"]);
    assert.equal("mode" in result && result.mode, "structured_wiki_scoped");
    assert.ok(!JSON.stringify(result).includes("UNTRUSTED LIVE CONTENT"));
    const hit = result.results[0];
    assert.equal("saleItemId" in hit && hit.saleItemId, "s1");
    const path = knowledgePath(releaseId, "sale-items", "s1");
    assert.equal(hit.path, path);
    const read = tools.find((t) => t.name === "wiki_read")!;
    await read.execute("read", { path });
    await assert.rejects(
      read.execute("foreign", {
        path: knowledgePath(nextId, "sale-items", "s1"),
      }),
      /固定知识版本/,
    );
    const nested = structuredClone(data.saleItems[0]);
    nested.specification_md =
      "### 功能介绍\n支持实时预览\n### 性能规格\n支持128路预览";
    assert.ok(
      parseSaleEntity(
        saleMarkdown(pinned as KnowledgeRelease, nested),
      ).specification.includes("支持128路预览"),
    );
    const content = saleMarkdown(pinned as KnowledgeRelease, data.saleItems[0]);
    const line = content.split("\n").findIndex((l) => l === "支持实时预览") + 1;
    const proof = {
      snapshotId: hit.snapshotId,
      lineStart: line,
      lineEnd: line,
      quote: "支持实时预览",
    };
    const item: AssessmentInput = {
      requirementId: "T-1",
      product: "产品A",
      version: "v1",
      sales: ["视频监控"],
      level: "exact",
      ok: ["实时预览"],
      no: [],
      hard: [],
      note: "发布证据核实",
      criteria: {
        direction: "提供",
        scope: "实时预览",
        spec: "无额外参数",
        context: "视频场景",
        delivery: "原生",
      },
      evidence: [proof],
      dependencies: [],
      mustSelect: [],
      verification: {
        version: 2,
        checks: [
          {
            subrequirementId: "T-1.1",
            level: "exact",
            direction: "提供",
            reason: "原文支持",
            delivery: "native",
            deliveryConfirmed: true,
            evidence: [proof],
          },
        ],
        contributions: [
          {
            id: "video",
            product: "产品A",
            version: "v1",
            sales: "视频监控",
            moduleId: "VIDEO",
            path,
            capability: "实时预览",
            subrequirementIds: ["T-1.1"],
            purpose: "purchase",
            reason: "新增能力",
            evidence: [proof],
          },
        ],
        integrationRequired: false,
        integrations: [],
        supplementalSearch: [],
        counterchecks: {
          direction: "一致",
          omissions: "无",
          quantitative: "无",
          external: "无",
          integration: "无需",
        },
      },
    };
    const incomplete = structuredClone(pinned as KnowledgeRelease);
    incomplete.data.saleItems[0].specification_md = null;
    incomplete.data.saleItems[0].description = "支持实时预览";
    const incompleteContent = saleMarkdown(
      incomplete,
      incomplete.data.saleItems[0],
    );
    await db.query("UPDATE public.kb_releases SET data=$2::jsonb WHERE id=$1", [
      releaseId,
      JSON.stringify(incomplete.data),
    ]);
    await db.query("UPDATE snapshots SET content=$2 WHERE id=$1", [
      hit.snapshotId,
      incompleteContent,
    ]);
    const unsupported = structuredClone(item);
    const descriptionLine =
      incompleteContent.split("\n").findIndex((l) => l === "支持实时预览") + 1;
    const unsupportedProof = {
      ...proof,
      lineStart: descriptionLine,
      lineEnd: descriptionLine,
    };
    unsupported.evidence = [unsupportedProof];
    unsupported.verification!.checks[0].evidence = [unsupportedProof];
    unsupported.verification!.contributions[0].evidence = [unsupportedProof];
    await assert.rejects(
      saveAssessments(db, pid, [unsupported], {}),
      /技术规格待确认/,
    );
    await db.query("UPDATE public.kb_releases SET data=$2::jsonb WHERE id=$1", [
      releaseId,
      JSON.stringify((pinned as KnowledgeRelease).data),
    ]);
    await db.query("UPDATE snapshots SET content=$2 WHERE id=$1", [
      hit.snapshotId,
      content,
    ]);
    await saveAssessments(db, pid, [item], {});
    const saved = (await assessmentRows(db, pid, 10, 0))[0];
    assert.equal(saved.knowledgeReleaseId, releaseId);
    assert.equal(saved.verification?.contributions[0].saleItemId, "s1");
    const wrong = structuredClone(item);
    wrong.verification!.contributions[0].saleItemId = "s2";
    await assert.rejects(saveAssessments(db, pid, [wrong], {}), /销售项ID/);
    const page = { id: hit.snapshotId, path, content };
    await assert.rejects(
      validateCatalogSale(
        db,
        pid,
        { name: "产品A", version: "v2", path: "" },
        page,
        "v2",
      ),
      /固定发布版本/,
    );
    const pages = await db.query<{
      id: string;
      path: string;
      content: string;
      hash: string;
    }>("SELECT id,path,content,hash FROM snapshots WHERE project_id=$1", [pid]);
    const second = structuredClone(saved);
    second.requirementId = "T-2";
    const summary = summarizeSales([saved, second], pages);
    assert.equal(summary.sales.length, 1);
    assert.equal(summary.sales[0].entity.price, 5000);
    assert.equal(summary.sales[0].requirements.size, 2);
    const mutual = structuredClone(pinned as KnowledgeRelease);
    mutual.data.saleItems[1].product_version_id = "v1";
    mutual.data.saleItems[1].name = "音频采集终端管理";
    mutual.data.dependencies = [
      {
        dependency_id: "a-b",
        sale_item_id: "s1",
        depends_on_sale_item_id: "s2",
        dependency_type: "required",
        condition_note: null,
        source_note: "原文必选",
      },
      {
        dependency_id: "b-a",
        sale_item_id: "s2",
        depends_on_sale_item_id: "s1",
        dependency_type: "required",
        condition_note: null,
        source_note: "原文必选",
      },
    ];
    const mutualPages = mutual.data.saleItems.map((sale) => {
      const content = saleMarkdown(mutual, sale);
      return {
        id: randomUUID(),
        path: knowledgePath(mutual.id, "sale-items", sale.sale_item_id),
        content,
        hash: createHash("sha256").update(content).digest("hex"),
      };
    });
    const mutualRows = mutual.data.saleItems.map((sale, i) => ({
      ...saved,
      verification: undefined,
      sales: [sale.name],
      version: "v1",
      evidence: [{ ...proof, snapshotId: mutualPages[i].id }],
    }));
    const mutualSummary = summarizeSales(
      [...mutualRows, ...mutualRows],
      mutualPages,
    );
    assert.equal(
      mutualSummary.sales.length,
      2,
      "互相依赖应保留两项，重复引用按稳定ID去重",
    );
    assert.equal(
      mutualSummary.issues.length,
      0,
      "双方均已列入时不应报缺失依赖",
    );
    assert.ok(
      summarizeSales(mutualRows.slice(0, 1), mutualPages).issues.some((s) =>
        s.includes("尚未列入"),
      ),
      "互相依赖不能免除另一项的交付要求",
    );

    const secondItem = structuredClone(item);
    secondItem.requirementId = "T-2";
    secondItem.verification!.checks[0].subrequirementId = "T-2.1";
    secondItem.verification!.contributions[0].subrequirementIds = ["T-2.1"];
    await saveAssessments(db, pid, [secondItem], {});
    await db.query("UPDATE assessments SET reviewed=true WHERE project_id=$1", [
      pid,
    ]);
    const report = await createReport(db, pid, "xlsx", "sales");
    const [artifact] = await db.query<{
      manifest: { sales: { saleItemId: string; knowledgeReleaseId: string }[] };
    }>("SELECT manifest FROM artifacts WHERE id=$1", [report.id]);
    assert.equal(artifact.manifest.sales[0].saleItemId, "s1");
    assert.equal(artifact.manifest.sales[0].knowledgeReleaseId, releaseId);
    const fallback = await searchGlobalFallback(db, pid, rid, {
      requirementId: "T-1",
      query: "实时预览",
      topK: 5,
      reason: "insufficient_evidence",
      explanation: "现有候选参数仍需补查其他版本能力",
    });
    assert.equal(fallback.stage, "global_fallback");
    assert.ok("results" in fallback);
    const other = ("results" in fallback ? fallback.results : []).find(
      (r) => "saleItemId" in r && r.saleItemId === "s2",
    )!;
    assert.ok(other, "固定发布版本内全局补查可以找到未选版本");
    const otherContent = saleMarkdown(
      pinned as KnowledgeRelease,
      data.saleItems[1],
    );
    const otherLine =
      otherContent.split("\n").findIndex((l) => l === "支持实时预览") + 1;
    await recordAlternative(db, pid, rid, {
      requirementId: "T-1",
      product: {
        name: "产品A",
        version: "v2",
        path: knowledgePath(releaseId, "products", "p"),
      },
      sales: "视频监控",
      reason: "其他版本有实时预览原文，可以核实后追加选择",
      evidence: {
        snapshotId: other.snapshotId,
        lineStart: otherLine,
        lineEnd: otherLine,
        quote: "支持实时预览",
      },
    });
    const fresh = randomUUID();
    await db.query(
      "INSERT INTO projects(id,name,wiki_project_id,owner_id) VALUES($1,'未确认','structured',$2)",
      [fresh, uid],
    );
    await assert.rejects(
      selectProducts(db, fresh, uid, {
        expectedRevision: 99,
        selected: [{ name: "产品A", version: "v1", path: "" }],
        strategy: "",
      }),
      /刷新/,
    );
    assert.equal(
      await projectKnowledge(db, fresh),
      null,
      "过期确认不能永久绑定",
    );
    await assert.rejects(
      selectProducts(db, fresh, uid, {
        expectedRevision: 1,
        selected: [{ name: "不存在的产品", version: "v1", path: "" }],
        strategy: "",
      }),
      /未唯一定位/,
    );
    assert.equal(
      await projectKnowledge(db, fresh),
      null,
      "无效产品导致确认失败应回滚绑定",
    );
    const old = randomUUID();
    await db.query(
      "INSERT INTO projects(id,name,wiki_project_id,owner_id) VALUES($1,'历史','structured',$2)",
      [old, uid],
    );
    await db.query(
      "INSERT INTO product_scopes(project_id,status) VALUES($1,'legacy')",
      [old],
    );
    assert.equal(await projectKnowledge(db, old, true), null);
  } finally {
    WikiClient.prototype.search = originalSearch;
    await db.close();
  }
});
