import { test } from "node:test";
import assert from "node:assert/strict";
import { createReport } from "../server/reports.js";
import { randomUUID } from "node:crypto";
import { openDatabase, migrate } from "../server/db.js";
import { createTools } from "../server/tools.js";
import {
  projectKnowledge,
  knowledgePath,
  saleMarkdown,
} from "../server/structured-knowledge.js";
import {
  searchSelected,
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
    await db.close();
  }
});
