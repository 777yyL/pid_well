// Isolated browser QA environment. Never seeds the user's working database.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase, migrate } from "../server/db.js";
import { createApp } from "../server/index.js";
import { hashPassword } from "../server/auth.js";
import { snapshotPage } from "../server/wiki.js";
import { captureReport, createReport } from "../server/reports.js";
import { renderReportHtml } from "../server/report-layout.js";
const directory = await mkdtemp(join(tmpdir(), "tender-ui-"));
const db = await openDatabase("", directory);
await migrate(db);
const userId = randomUUID();
const projectId = randomUUID();
await db.query(
  "INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5)",
  [
    userId,
    "qa_user",
    "界面验证账号",
    await hashPassword("isolated-ui-test"),
    "admin",
  ],
);
await db.query("INSERT INTO bootstrap(id) VALUES(1)");
await db.query(
  "INSERT INTO projects(id,name,description,wiki_project_id,owner_id) VALUES($1,$2,$3,$4,$5)",
  [
    projectId,
    "界面验证项目",
    "仅用于浏览器交互验证，不属于实际业务数据",
    "ec087b7b-beb8-4e7d-920c-b6d169e58a9d",
    userId,
  ],
);
if (process.env.QA_PROJECTS === "true") {
  for (const [index, name] of [
    "园区综合安防评估",
    "人员通行系统选型",
    "智慧楼宇招标清单",
    "历史交付方案",
  ].entries()) {
    await db.query(
      "INSERT INTO projects(id,name,description,wiki_project_id,owner_id,archived_at,created_at) VALUES($1,$2,$3,'qa-only',$4,$5,now()-$6::int*interval '1 day')",
      [
        randomUUID(),
        name,
        "隔离界面验证数据：核对项目布局、筛选与管理操作",
        userId,
        index === 3 ? new Date().toISOString() : null,
        index + 1,
      ],
    );
  }
}
if (process.env.QA_KNOWLEDGE === "true") {
  const { projectKnowledge, overviewMarkdown } =
    await import("../server/structured-knowledge.js");
  await db.query(
    "INSERT INTO product_kb.kb_products(product_id,product_code,name,product_line,department,owner,summary,status,source_path) VALUES('isc','iSecure Center','综合安防管理平台','综合安防软件','综合安防产品部','产品维护人','面向园区的综合安防管理，覆盖视频应用、人员通行及基础服务。','active','wiki/entities/products/isc.md')",
  );
  await db.query(
    "INSERT INTO product_kb.kb_product_versions(product_version_id,product_id,version,status) VALUES('v1','isc','v1.0.0','active'),('v2','isc','v2.0.0','active')",
  );
  for (const [i, name] of ["智慧通行", "视频应用", "基础服务"].entries())
    await db.query(
      "INSERT INTO product_kb.kb_categories(category_id,product_version_id,name,sort_order) VALUES($1,'v1',$2,$3)",
      ["c" + i, name, i],
    );
  const names = [
    "门禁管理",
    "访客管理",
    "人员通行",
    "重点区域门禁管控",
    "人脸通行",
    "梯控管理",
    "车行管理",
    "视频监控",
    "录像回放",
    "视频巡检",
    "视频联动",
    "视频检索",
    "告警管理",
    "基础包",
    "组织管理",
    "设备管理",
    "地图应用",
  ];
  for (const [i, name] of names.entries())
    await db.query(
      "INSERT INTO product_kb.kb_sale_items(sale_item_id,product_version_id,category_id,module_code,name,description,specification_md,unit,price_type,fixed_price,currency,mandatory,authorization_note,source_path,status) VALUES($1,'v1',$2,$3,$4,$5,$6,'套','fixed',$7,'CNY',false,'按实际部署核定授权，不默认跨产品共享',$8,'active')",
      [
        "sale" + i,
        "c" + (i < 7 ? 0 : i < 13 ? 1 : 2),
        "ISC-" + i,
        name,
        "用于" + name + "业务场景",
        "### 功能介绍\n支持" +
          name +
          "配置及事件查询。\n### 使用条件\n需部署基础服务，实际设备兼容性需核实。",
        i === 0 ? 0 : 5000 + i * 100,
        "wiki/entities/sale-items/sale" + i + ".md",
      ],
    );
  const data = {
    products: await db.query("SELECT * FROM product_kb.kb_products"),
    versions: await db.query("SELECT * FROM product_kb.kb_product_versions"),
    categories: await db.query("SELECT * FROM product_kb.kb_categories"),
    saleItems: await db.query("SELECT * FROM product_kb.kb_sale_items"),
    dependencies: [],
  };
  await db.query(
    "INSERT INTO product_kb.kb_releases(id,wiki_project_id,name,data,created_by) VALUES($1,'ec087b7b-beb8-4e7d-920c-b6d169e58a9d','目录验证版',$2,$3)",
    [randomUUID(), JSON.stringify(data), userId],
  );
  const release = await projectKnowledge(db, projectId, true);
  const overview = await snapshotPage(
    db,
    projectId,
    "wiki/overview.md",
    overviewMarkdown(release!),
  );
  const rec = {
    name: "iSecure Center",
    version: "v1.0.0",
    path: "wiki/entities/products/isc.md",
    productId: "iSecure Center",
    productName: "综合安防管理平台",
    productLine: "综合安防软件",
    department: "综合安防产品部",
    owner: "产品维护人",
    reason: "综合安防平台覆盖本项目视频和通行需求，建议优先核实目录。",
    coverage: "覆盖视频、通行及基础服务",
    gaps: "具体参数及授权待逐条核实",
    evidence: [
      {
        snapshotId: overview.id,
        lineStart: 1,
        lineEnd: overview.content.split("\n").length,
        quote: overview.content,
      },
    ],
  };
  const combinations = [
    {
      name: "综合安防单平台",
      summary: "以综合安防平台覆盖主要业务，具体模块及参数后续逐项核实。",
      products: [{ name: rec.name, version: rec.version, role: "主平台" }],
    },
  ];
  await db.query(
    "INSERT INTO product_scopes(project_id,status,recommendations) VALUES($1,'pending',$2)",
    [projectId, JSON.stringify([rec])],
  );
  await db.query(
    "INSERT INTO audit_log(project_id,action,data) VALUES($1,'products_recommended',$2)",
    [projectId, JSON.stringify({ combinations })],
  );
}
const { app } = await createApp(db, true);
if (process.env.QA_REPORTS === "true") {
  await db.query(
    "UPDATE projects SET name='园区安防 · 成果展示验证（隔离测试）' WHERE id=$1",
    [projectId],
  );
  await db.query(
    "INSERT INTO product_scopes(project_id,status) VALUES($1,'legacy')",
    [projectId],
  );
  const documentId = randomUUID();
  const lines = [
    "支持门禁权限管理及人员通行事件查询。",
    "应支持跨主机多门互锁，最多128个门，并支持视频联动。",
    "前端摄像机应具备设备硬件安全认证能力。",
  ];
  await db.query(
    "INSERT INTO documents(id,project_id,name,storage_name,hash,status,lines) VALUES($1,$2,'界面验证清单.txt','qa-only','qa-only','ready',$3)",
    [documentId, projectId, JSON.stringify(lines)],
  );
  const specification =
    "【功能介绍】\n支持人员门禁权限分组、通行事件查询、单机多门互锁与反潜回。认证方式及设备能力以实际部署为准。\n【性能规格】\n单个控制器最多4门互锁。跨主机128门互锁规格尚未在该测试证据中提供。\n".repeat(
      6,
    );
  const access = await snapshotPage(
    db,
    projectId,
    "wiki/entities/access-qa.md",
    `---\ntype: sale-item\ntitle: 门禁管理\nproduct: 界面验证产品\nversion: v1\nmodule_id: ACS-001\nunit: 套\nfixed_price: 5000\n---\n## 技术规格\n${specification}\n## 报价说明\n5000元/套，数量由销售核定。`,
  );
  const video = await snapshotPage(
    db,
    projectId,
    "wiki/entities/video-qa.md",
    "---\ntype: sale-item\ntitle: 视频管理\nproduct: 界面验证产品\nversion: v1\nmodule_id: VMS-001\nunit: 套\nfixed_price: 0\n---\n## 技术规格\n支持实时预览、事件视频联动和录像查询。",
  );
  const levels = ["exact", "partial", "no_match"] as const;
  for (const [index, level] of levels.entries()) {
    const requirementId = `T-${index + 1}`;
    await db.query(
      "INSERT INTO requirements(id,project_id,data,confirmed) VALUES($1,$2,$3,true)",
      [
        requirementId,
        projectId,
        JSON.stringify({
          id: requirementId,
          documentId,
          module: "人员通行与视频",
          type: "功能",
          raw: lines[index],
          lineStart: index + 1,
          lineEnd: index + 1,
        }),
      ],
    );
    await db.query(
      "INSERT INTO assessments(id,project_id,requirement_id,data,source,reviewed) VALUES($1,$2,$3,$4,$5,true)",
      [
        randomUUID(),
        projectId,
        requirementId,
        JSON.stringify({
          requirementId,
          product: "界面验证产品",
          version: "v1",
          sales:
            level === "no_match"
              ? []
              : index === 0
                ? ["门禁管理"]
                : ["门禁管理", "视频管理"],
          level,
          ok: level === "no_match" ? [] : ["权限管理与事件查询能力已具备"],
          hard:
            level === "partial"
              ? ["跨主机128门互锁规格需要产品与交付团队核实"]
              : [],
          no:
            level === "no_match" ? ["软件销售项不覆盖摄像机硬件安全认证"] : [],
          note: "隔离测试数据：仅用于验证成果物排版与分享，不作为业务结论。",
          criteria: {
            direction: "人员通行与视频方向一致",
            scope: "仅覆盖测试证据明确说明的功能",
            spec: "跨主机性能规格未提供",
            context: "园区安防验证场景",
            delivery: "投标前需确认授权、设备与交付范围",
          },
          evidence: (index === 1 ? [access, video] : [access]).map((page) => ({
            snapshotId: page.id,
            lineStart: 1,
            lineEnd: 1,
            quote: "---",
          })),
          dependencies:
            process.env.QA_PROCUREMENT === "true" && index === 0
              ? ["主产品基础包授权待核实"]
              : [],
          mustSelect: [],
        }),
        index === 0 ? "human" : "agent",
      ],
    );
  }
  const frozen = await captureReport(db, projectId);
  await createReport(db, projectId, "xlsx", "full", frozen);
  await createReport(db, projectId, "xlsx", "sales", frozen);
  app.get("/qa/report", async (_request, reply) =>
    reply.type("text/html").send(renderReportHtml(frozen, "隔离验证报告")),
  );
}
if (process.env.QA_PRODUCTS === "true") {
  const quote =
    "园区平台支持视频管理、人员通行和事件联动；轻量平台适合独立门禁场景。";
  const overviewText =
    quote +
    "\n## iSecure Center\n产品标识 iSecure Center · 产品名称 综合安防管理平台 · 产品类目 综合安防软件 / 综合安防管理平台 · 所属部门 软件产品研发中心/通用软件产品部/综合安防产品部 · 维护人 左志红 产品描述 综合安防管理平台，简称iSC。";
  const page = await snapshotPage(
    db,
    projectId,
    "wiki/overview.md",
    overviewText,
  );
  const candidates = [
    {
      name: "iSecure Center",
      productId: "PARK-IOC",
      productLine: "综合安防",
      department: "平台产品部",
      owner: "界面测试负责人",
      version: "v2.1",
      reason:
        "推荐优先评估园区综合平台，统一视频与门禁业务。多子系统协作场景下可减少重复建设，并保留事件联动能力，具体授权范围仍需核实。",
      coverage: "- 视频管理与录像查询\n- 人员通行与权限管理\n- 事件联动",
      gaps: "跨主机容量与第三方集成需核实",
    },
    {
      name: "轻量门禁平台",
      version: "v1.0",
      reason:
        "适用于独立门禁场景，功能范围明确、部署简单。若项目涉及视频联动或复杂系统整合，需要补充产品能力证据。",
      coverage: "人员通行、门禁权限与事件查询",
      gaps: "综合视频能力尚未核实",
    },
  ].map((p) => ({
    ...p,
    path: "wiki/entities/qa-product.md",
    evidence: [{ snapshotId: page.id, lineStart: 1, lineEnd: 1, quote }],
  }));
  await db.query(
    "INSERT INTO product_scopes(project_id,recommendations) VALUES($1,$2) ON CONFLICT(project_id) DO UPDATE SET status='pending',recommendations=$2",
    [projectId, JSON.stringify(candidates)],
  );
}
if (
  process.env.QA_PRODUCTS === "true" &&
  process.env.QA_OLD_RECOMMENDATION !== "true"
) {
  await db.query(
    "INSERT INTO audit_log(project_id,action,data) VALUES($1,'products_recommended',$2)",
    [
      projectId,
      JSON.stringify({
        combinations: [
          {
            name: "园区一体化方案",
            summary:
              "以园区综合平台统一视频、通行和事件联动，减少多系统部署。容量和授权范围需要后续核实。",
            products: [
              {
                name: "iSecure Center",
                version: "v2.1",
                role: "主平台：统一视频、人员通行与事件联动",
              },
            ],
          },
          {
            name: "轻量通行方案",
            summary:
              "面向独立门禁场景，优先部署轻量平台；不将综合视频能力作为已满足项。",
            products: [
              {
                name: "轻量门禁平台",
                version: "v1.0",
                role: "通行管理：门禁权限、人员通行与事件查询",
              },
            ],
          },
        ],
      }),
    ],
  );
}
if (process.env.QA_ALTERNATIVES === "true") {
  const chosen = {
    name: "当前门禁平台",
    version: "v1",
    path: "wiki/entities/products/current.md",
  };
  await db.query(
    "INSERT INTO product_scopes(project_id,status,selected) VALUES($1,'confirmed',$2) ON CONFLICT(project_id) DO UPDATE SET status='confirmed',selected=$2",
    [projectId, JSON.stringify([chosen])],
  );
  const page = await snapshotPage(
    db,
    projectId,
    "wiki/entities/sale-items/alternative.md",
    "# 视频联动\n支持通行事件与视频联动",
  );
  await db.query(
    "INSERT INTO audit_log(project_id,action,data) VALUES($1,'product_alternative',$2)",
    [
      projectId,
      JSON.stringify({
        requirementId: "T-2",
        product: {
          name: "综合安防平台",
          version: "v2.1",
          path: "wiki/entities/products/alternative.md",
        },
        sales: "视频联动",
        reason:
          "当前门禁平台缺少视频联动证据。综合安防平台提供通行事件的视频联动能力，可作为组合产品补充。",
        scopeRevision: 1,
        evidence: {
          snapshotId: page.id,
          lineStart: 2,
          lineEnd: 2,
          quote: "支持通行事件与视频联动",
        },
      }),
    ],
  );
}
let qaActivityTimer: ReturnType<typeof setInterval> | undefined;
if (process.env.QA_ACTIVITY === "true") {
  const conversation = randomUUID(),
    run = randomUUID(),
    document = randomUUID();
  const title = "隔离验证：读取阶段模拟，不调用模型";
  await db.query(
    "INSERT INTO conversations(id,project_id,title,plan) VALUES($1,$2,$3,$4)",
    [
      conversation,
      projectId,
      title,
      JSON.stringify([
        { id: "prepare", title: "了解项目背景", status: "done" },
        { id: "read", title: "阅读招标原文", status: "running" },
        { id: "extract", title: "提取技术条款", status: "pending" },
        { id: "select", title: "确认产品选型", status: "pending" },
        { id: "verify", title: "核实销售项与规格", status: "pending" },
        { id: "report", title: "复核与导出成果", status: "pending" },
      ]),
    ],
  );
  await db.query(
    "INSERT INTO documents(id,project_id,name,storage_name,hash,status,lines) VALUES($1,$2,'隔离验证清单.txt','qa-activity','qa-activity','ready',$3)",
    [
      document,
      projectId,
      JSON.stringify(
        Array.from({ length: 360 }, (_, i) => `界面测试原文 ${i + 1}`),
      ),
    ],
  );
  await db.query(
    "INSERT INTO runs(id,conversation_id,project_id,user_id,input,idempotency_key,status,created_at) VALUES($1,$2,$3,$4,$5,$6,'running',now()-interval '5 minutes')",
    [run, conversation, projectId, userId, title, randomUUID()],
  );
  await db.query(
    "INSERT INTO messages(id,conversation_id,run_id,role,content) VALUES($1,$2,$3,'user',$4)",
    [randomUUID(), conversation, run, title],
  );
  await db.query(
    "INSERT INTO run_events(run_id,type,payload,created_at) VALUES($1,'tool_execution_start',$2,now()-interval '80 seconds')",
    [
      run,
      JSON.stringify({
        toolCallId: "qa-reading",
        toolName: "read_document",
        args: { documentId: document, start: 145, count: 150 },
      }),
    ],
  );
  const phaseSince = Date.now() - 80000;
  const heartbeat = async () =>
    db.query(
      "INSERT INTO run_events(run_id,type,payload) VALUES($1,'run_progress',$2)",
      [
        run,
        JSON.stringify({
          phase: "执行工具：read_document",
          phaseSince,
          readLines: 144,
          totalLines: 360,
          requirements: 0,
          confirmed: 0,
          assessments: 0,
          reviewed: 0,
          turns: 2,
        }),
      ],
    );
  await heartbeat();
  qaActivityTimer = setInterval(() => void heartbeat().catch(() => {}), 5000);
}
if (process.env.QA_ACCURACY === "true") {
  const documentId = randomUUID();
  await db.query(
    "INSERT INTO documents(id,project_id,name,storage_name,hash,status,lines) VALUES($1,$2,'准确性验收.txt','qa-only','qa-only','ready',$3)",
    [documentId, projectId, JSON.stringify(["支持人脸通行", "支持事件查询"])],
  );
  const product = {
    name: "验收产品",
    version: "v1",
    path: "wiki/entities/products/accuracy-qa.md",
  };
  await snapshotPage(
    db,
    projectId,
    product.path,
    "---\ntype: product\ntitle: 验收产品\nversion: v1\n---\n[门禁](../sale-items/accuracy-qa.md)",
  );
  const sale = await snapshotPage(
    db,
    projectId,
    "wiki/entities/sale-items/accuracy-qa.md",
    "---\ntitle: 门禁管理\nproduct: 验收产品\nversion: v1\nmodule_id: ACS\n---\n支持人脸通行",
  );
  await db.query(
    "INSERT INTO product_scopes(project_id,status,selected) VALUES($1,'confirmed',$2)",
    [projectId, JSON.stringify([product])],
  );
  const proof = {
    snapshotId: sale.id,
    lineStart: 7,
    lineEnd: 7,
    quote: "支持人脸通行",
  };
  for (const [i, raw] of ["支持人脸通行", "支持事件查询"].entries()) {
    const id = `T-${i + 1}`;
    const sub = {
      id: `${id}.1`,
      raw,
      required: true,
      lineStart: i + 1,
      lineEnd: i + 1,
    };
    await db.query(
      "INSERT INTO requirements(id,project_id,data,confirmed) VALUES($1,$2,$3,true)",
      [
        id,
        projectId,
        JSON.stringify({
          id,
          documentId,
          module: "门禁",
          type: "功能",
          raw,
          lineStart: i + 1,
          lineEnd: i + 1,
          ...(i === 0 ? { subrequirements: [sub] } : {}),
        }),
      ],
    );
    if (i === 0)
      await db.query(
        "INSERT INTO assessments(id,project_id,requirement_id,data,source,reviewed) VALUES($1,$2,$3,$4,'agent',false)",
        [
          randomUUID(),
          projectId,
          id,
          JSON.stringify({
            requirementId: id,
            product: product.name,
            version: "v1",
            level: "exact",
            sales: ["门禁管理"],
            ok: [raw],
            hard: [],
            no: [],
            note: "隔离测试：验证表单保存",
            criteria: {
              direction: "输入",
              scope: "人脸通行",
              spec: "无数值要求",
              context: "园区",
              delivery: "原生",
            },
            evidence: [proof],
            dependencies: [],
            mustSelect: [],
            verification: {
              version: 2,
              checks: [
                {
                  subrequirementId: sub.id,
                  level: "exact",
                  direction: "人员通行",
                  reason: "原文明确支持",
                  delivery: "native",
                  deliveryConfirmed: true,
                  evidence: [proof],
                },
              ],
              contributions: [
                {
                  id: "C1",
                  product: product.name,
                  version: "v1",
                  sales: "门禁管理",
                  path: sale.path,
                  moduleId: "ACS",
                  capability: raw,
                  subrequirementIds: [sub.id],
                  purpose: "purchase",
                  reason: "直接满足",
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
                integration: "单产品",
              },
            },
          }),
        ],
      );
  }
}
if (process.env.QA_CAPABILITY === "true") {
  const Fastify = (await import("fastify")).default;
  const { saveSettings } = await import("../server/settings.js");
  const fixture = Fastify();
  const salePath = "wiki/entities/sale-items/demo-acs.md";
  const pages: Record<string, string> = {
    "wiki/overview.md":
      "产品标识 Demo · 产品名称 综合安防平台 · 所属部门 软件产品部 · 维护人 验收负责人 产品描述 门禁能力验收",
    "wiki/entities/products/demo.md":
      "---\ntitle: Demo\nversion: v1\n---\n[门禁管理](../sale-items/demo-acs.md)",
    [salePath]:
      "---\ntitle: 门禁管理\nproduct: Demo\nversion: v1\nmodule_id: ACS\nunit: 套\nfixed_price: 5000\n---\n支持多门互锁\n## 技术规格\n单控制器最多4门互锁，跨控制器容量待确认。",
  };
  fixture.get("/api/v1/projects", () => ({
    projects: [{ id: "qa-capability", name: "能力检索演示知识库（隔离）" }],
  }));
  fixture.get("/api/v1/projects/:id/files", () => ({
    truncated: false,
    files: Object.keys(pages).map((path) => ({ path: "//?/D:/qa/" + path })),
  }));
  fixture.get("/api/v1/projects/:id/files/content", async (request, reply) => {
    const path = (request.query as { path: string }).path;
    return pages[path] ? { content: pages[path] } : reply.code(404).send({});
  });
  fixture.post("/api/v1/projects/:id/search", () => ({
    results: [{ path: salePath }],
  }));
  fixture.post("/v1/chat/completions", async (request, reply) => {
    const body = request.body as { messages: { content: string }[] };
    const input = JSON.parse(body.messages.at(-1)!.content);
    const requirements = ["多门互锁", "跨控制器128门"];
    const result = input.candidates
      ? {
          results: [
            {
              path: salePath,
              checks: input.requirements.map(
                (requirement: string, i: number) => ({
                  requirement,
                  status: i === 0 ? "supported" : "unknown",
                  reason:
                    i === 0
                      ? "销售项原文提供多门互锁"
                      : "知识库仅说明单控制器4门，不能推断跨控制器128门容量",
                  delivery: i === 0 ? "native" : "unknown",
                  evidence:
                    i === 0
                      ? [{ lineStart: 9, lineEnd: 9, quote: "支持多门互锁" }]
                      : [],
                }),
              ),
            },
          ],
        }
      : { requirements, queries: ["多门互锁"] };
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
    reply.raw.write(
      `data: ${JSON.stringify({ id: "qa", object: "chat.completion.chunk", created: 1, model: "qa", choices: [{ index: 0, delta: { role: "assistant", content: JSON.stringify(result) }, finish_reason: null }] })}\n\n`,
    );
    reply.raw.write(
      `data: ${JSON.stringify({ id: "qa", object: "chat.completion.chunk", created: 1, model: "qa", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    );
    reply.raw.end("data: [DONE]\n\n");
  });
  await fixture.listen({ host: "127.0.0.1", port: 0 });
  const fixturePort = (fixture.server.address() as { port: number }).port;
  await saveSettings(db, {
    wikiBaseUrl: `http://127.0.0.1:${fixturePort}`,
    modelBaseUrl: `http://127.0.0.1:${fixturePort}/v1`,
    model: "isolated-capability",
    modelApiKey: "qa-only",
  });
  await db.query(
    "UPDATE projects SET wiki_project_id='qa-capability',name='能力检索验收（隔离数据）' WHERE id=$1",
    [projectId],
  );
  app.addHook("onClose", () => fixture.close());
}
await app.listen({
  host: process.env.QA_HOST ?? "127.0.0.1",
  port: Number(process.env.QA_PORT ?? 4321),
});
async function close() {
  if (qaActivityTimer) clearInterval(qaActivityTimer);
  await app.close();
  await db.close();
  process.exit(0);
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
