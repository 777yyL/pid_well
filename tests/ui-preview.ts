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
const { app } = await createApp(db, true);
if (process.env.QA_REPORTS === "true") {
  await db.query("UPDATE projects SET name='园区安防 · 成果展示验证（隔离测试）' WHERE id=$1", [projectId]);
  await db.query("INSERT INTO product_scopes(project_id,status) VALUES($1,'legacy')", [projectId]);
  const documentId = randomUUID();
  const lines = ["支持门禁权限管理及人员通行事件查询。", "应支持跨主机多门互锁，最多128个门，并支持视频联动。", "前端摄像机应具备设备硬件安全认证能力。"];
  await db.query("INSERT INTO documents(id,project_id,name,storage_name,hash,status,lines) VALUES($1,$2,'界面验证清单.txt','qa-only','qa-only','ready',$3)", [documentId, projectId, JSON.stringify(lines)]);
  const specification = "【功能介绍】\n支持人员门禁权限分组、通行事件查询、单机多门互锁与反潜回。认证方式及设备能力以实际部署为准。\n【性能规格】\n单个控制器最多4门互锁。跨主机128门互锁规格尚未在该测试证据中提供。\n".repeat(6);
  const access = await snapshotPage(db, projectId, "wiki/entities/access-qa.md", `---\ntype: sale-item\ntitle: 门禁管理\nproduct: 界面验证产品\nversion: v1\nmodule_id: ACS-001\nunit: 套\nfixed_price: 5000\n---\n## 技术规格\n${specification}\n## 报价说明\n5000元/套，数量由销售核定。`);
  const video = await snapshotPage(db, projectId, "wiki/entities/video-qa.md", "---\ntype: sale-item\ntitle: 视频管理\nproduct: 界面验证产品\nversion: v1\nmodule_id: VMS-001\nunit: 套\nfixed_price: 0\n---\n## 技术规格\n支持实时预览、事件视频联动和录像查询。");
  const levels = ["exact","partial","no_match"] as const;
  for (const [index, level] of levels.entries()) {
    const requirementId = `T-${index+1}`;
    await db.query("INSERT INTO requirements(id,project_id,data,confirmed) VALUES($1,$2,$3,true)", [requirementId, projectId, JSON.stringify({id:requirementId,documentId,module:"人员通行与视频",type:"功能",raw:lines[index],lineStart:index+1,lineEnd:index+1})]);
    await db.query("INSERT INTO assessments(id,project_id,requirement_id,data,source,reviewed) VALUES($1,$2,$3,$4,$5,true)", [randomUUID(),projectId,requirementId,JSON.stringify({requirementId,product:"界面验证产品",version:"v1",sales:level==="no_match"?[]:index===0?["门禁管理"]:["门禁管理","视频管理"],level,ok:level==="no_match"?[]:["权限管理与事件查询能力已具备"],hard:level==="partial"?["跨主机128门互锁规格需要产品与交付团队核实"]:[],no:level==="no_match"?["软件销售项不覆盖摄像机硬件安全认证"]:[],note:"隔离测试数据：仅用于验证成果物排版与分享，不作为业务结论。",criteria:{direction:"人员通行与视频方向一致",scope:"仅覆盖测试证据明确说明的功能",spec:"跨主机性能规格未提供",context:"园区安防验证场景",delivery:"投标前需确认授权、设备与交付范围"},evidence:(index===1?[access,video]:[access]).map((page) => ({snapshotId:page.id,lineStart:1,lineEnd:1,quote:"---"})),dependencies:[],mustSelect:[]}),index===0?"human":"agent"]);
  }
  const frozen = await captureReport(db, projectId);
  await createReport(db, projectId, "xlsx", "full", frozen);
  await createReport(db, projectId, "xlsx", "sales", frozen);
  app.get("/qa/report", async (_request, reply) => reply.type("text/html").send(renderReportHtml(frozen,"隔离验证报告")));
}
await app.listen({ host: process.env.QA_HOST ?? "127.0.0.1", port: Number(process.env.QA_PORT ?? 4321) });
async function close() {
  await app.close();
  await db.close();
  process.exit(0);
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
