import ExcelJS from "exceljs";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "./db.js";
import { assessmentRows } from "./assessment.js";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { summarizeSales, salesHeaders } from "./sale-entity.js";
import { productScope } from "./product-scope.js";
import { sourceCoverage } from "./source-coverage.js";
import {
  coverageLabel,
  accuracySummary,
  assessmentEvidence,
} from "../shared/accuracy.js";
import {
  styleTable,
  addOverview,
  addSalesDetails,
  renderReportHtml,
} from "./report-layout.js";
export const safeCell = (value: unknown) => {
  const text = String(value ?? "");
  return /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
};
export const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
export async function captureReport(db: Database, projectId: string) {
  return db.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const [project] = await tx.query<{
      id: string;
      name: string;
      wiki_project_id: string;
    }>("SELECT id,name,wiki_project_id FROM projects WHERE id=$1", [projectId]);
    if (!project) throw new AppError(404, "项目不存在");
    const requirements = await tx.query<{ id: string; confirmed: boolean }>(
      "SELECT id,confirmed FROM requirements WHERE project_id=$1",
      [projectId],
    );
    const rows = await assessmentRows(tx, projectId);
    if (
      !requirements.length ||
      rows.length !== requirements.length ||
      requirements.some((r) => !r.confirmed) ||
      rows.some((r) => !r.reviewed)
    )
      throw new AppError(409, "正式报告需要全部条款已确认、已匹配且已复核");
    const pages = await tx.query<{
      id: string;
      path: string;
      content: string;
      hash: string;
    }>("SELECT * FROM snapshots WHERE project_id=$1", [projectId]);
    const docs = await tx.query<{ id: string; name: string; hash: string }>(
      "SELECT id,name,hash FROM documents WHERE project_id=$1",
      [projectId],
    );
    return {
      project,
      rows,
      pages,
      docs,
      sourceCoverage: await sourceCoverage(tx, projectId),
      scope: await productScope(tx, projectId),
      generatedAt: new Date().toISOString(),
    };
  });
}
export type ReportSnapshot = Awaited<ReturnType<typeof captureReport>>;
export async function createReport(
  db: Database,
  projectId: string,
  format: "xlsx" | "csv" | "html",
  kind: "full" | "sales" = "full",
  frozen?: ReportSnapshot,
) {
  if (kind === "sales" && format !== "xlsx")
    throw new AppError(400, "销售项清单使用 XLSX 模板格式");
  const snapshot = frozen ?? (await captureReport(db, projectId));
  if (snapshot.project.id !== projectId)
    throw new AppError(400, "报告项目不一致");
  const { project, rows, pages, docs } = snapshot;
  const procurement = summarizeSales(rows, pages);
  const sales = procurement.sales;
  const saleRows = sales.map(({ entity, requirements }, index) => {
    const missing = [
      ["产品", entity.product],
      ["版本", entity.version],
      ["型号", entity.moduleId],
      ["技术规格", entity.specification],
      ["单位", entity.unit],
      ["单价", entity.price === undefined ? "" : String(entity.price)],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    const remarks = [
      procurement.issues.length &&
        "当前为待核实参考清单；采购核定事项见独立工作表",
      entity.description,
      entity.quotation && `报价说明：${entity.quotation}`,
      entity.version && `版本：${entity.version}`,
      entity.mandatory && `必选：${entity.mandatory}`,
      entity.dependencyNote && `依赖销售项：${entity.dependencyNote}`,
      `关联条款：${[...requirements].join("、")}`,
      missing.length && `知识库未提供：${missing.join("、")}`,
      entity.quantity === undefined && "数量待销售核定；合价不自动估算",
    ]
      .filter(Boolean)
      .join("\n");
    return [
      index + 1,
      entity.title,
      [entity.product, entity.category].filter(Boolean).join(" / "),
      entity.moduleId,
      entity.specification || "知识库未提供",
      entity.unit,
      entity.quantity ?? "",
      entity.price ?? "",
      entity.total ??
        (entity.quantity !== undefined && entity.price !== undefined
          ? entity.quantity * entity.price
          : ""),
      remarks,
    ];
  });
  const headers = [
    "编号",
    "模块",
    "功能点（原始清单）",
    "匹配销售项",
    "匹配证据",
    "偏离",
    "满足(ok)",
    "需定制(hard)",
    "不满足(no)",
    "结论说明",
    "证据引用",
    "子要求与组合核验",
    "复核来源",
    "原文覆盖检查",
  ];
  const details = rows.flatMap((row) =>
    (row.sales.length ? row.sales : ["—"]).map((sale) => [
      row.requirementId,
      row.module,
      row.requirement_raw,
      sale,
      assessmentEvidence(row)
        .map((e) => e.quote)
        .join("\n"),
      {
        exact: "完全满足",
        partial: "部分满足",
        no_match: "不满足",
        unknown: "待确认",
      }[row.level],
      row.ok.join("\n"),
      row.hard.join("\n"),
      row.no.join("\n"),
      row.note,
      assessmentEvidence(row)
        .map(
          (e) =>
            `${pages.find((p) => p.id === e.snapshotId)?.path ?? e.snapshotId}:L${e.lineStart}-L${e.lineEnd} [${e.snapshotId}]`,
        )
        .join("\n"),
      accuracySummary(row) +
        (procurement.issues.length
          ? `\n采购核定事项：${procurement.issues.join("；")}`
          : ""),
      row.source === "human" ? "人工确认" : row.reviewed ? "AI 自检" : "待自检",
      snapshot.sourceCoverage
        ?.map(
          (d) =>
            `${d.name} ${coverageLabel(d.status)}；未检查 ${d.uncheckedLines.length} 行`,
        )
        .join("\n") || "待检查",
    ]),
  );
  const id = randomUUID();
  const name = `${project.name}-${kind === "sales" ? "销售项清单" : "评估报告"}${procurement.issues.length ? "（采购待核实）" : ""}.${format}`;
  const storageName = `${id}.${format}`;
  const manifest = {
    projectId,
    wikiProjectId: project.wiki_project_id,
    knowledgeReleaseIds: [
      ...new Set(rows.map((r) => r.knowledgeReleaseId).filter(Boolean)),
    ],
    generatedAt: snapshot.generatedAt,
    kind,
    productScope: snapshot.scope,
    sourceCoverage: snapshot.sourceCoverage,
    procurementIssues: procurement.issues,
    componentReuse: procurement.reused,
    sales: sales.map(({ entity, page, requirements }) => ({
      title: entity.title,
      product: entity.product,
      version: entity.version,
      moduleId: entity.moduleId,
      saleItemId: entity.saleItemId,
      knowledgeReleaseId: entity.knowledgeReleaseId,
      snapshotId: page.id,
      hash: page.hash,
      requirements: [...requirements],
    })),
    requirements: rows.map((r) => ({
      id: r.requirementId,
      revision: r.revision,
      source: r.source,
    })),
    documents: docs,
    evidence: pages
      .filter((p) =>
        rows.some((r) =>
          assessmentEvidence(r).some((e) => e.snapshotId === p.id),
        ),
      )
      .map(({ content, ...rest }) => rest),
  };
  let buffer: Buffer;
  if (format === "xlsx") {
    const book = new ExcelJS.Workbook();
    book.creator = "评标AI";
    book.created = new Date();
    if (kind === "full") addOverview(book, snapshot, sales.length);
    const sheet = book.addWorksheet("功能点匹配报告", {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    sheet.addRow(headers);
    details.forEach((row) => sheet.addRow(row.map(safeCell)));
    styleTable(
      sheet,
      [12, 18, 52, 30, 58, 14, 30, 30, 30, 48, 40, 80, 18, 40],
      6,
    );
    const salesSheet = book.addWorksheet("销售项清单", {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    salesSheet.addRow(salesHeaders);
    saleRows.forEach((row) =>
      salesSheet.addRow(
        row.map((value) =>
          value === ""
            ? null
            : typeof value === "number"
              ? value
              : safeCell(value),
        ),
      ),
    );
    addSalesDetails(book, sales, salesSheet);
    styleTable(salesSheet, [9, 30, 26, 28, 58, 9, 11, 15, 17, 58]);
    for (const column of [7, 8, 9])
      salesSheet.getColumn(column).numFmt =
        column === 7 ? "#,##0.##" : "#,##0.00";
    const purchasing = book.addWorksheet("采购核定事项");
    purchasing.addRow(["类型", "核定事项"]);
    purchasing.addRow([
      "清单状态",
      procurement.issues.length
        ? "待核实参考清单，不作为最终采购或报价依据"
        : "已通过实体与依赖核对，数量与授权范围仍需销售核定",
    ]);
    procurement.issues.forEach((issue) => purchasing.addRow(["待确认", issue]));
    procurement.reused.forEach((r) =>
      purchasing.addRow([
        "组件复用",
        `${r.requirementId} · ${r.product} ${r.version} / ${r.sales} → ${r.source}；${r.reason}`,
      ]),
    );
    styleTable(purchasing, [18, 110]);
    const provenance = book.addWorksheet("证据与版本");
    provenance.addRow(["报告 ID", id]);
    provenance.addRow(["知识库项目", project.wiki_project_id]);
    provenance.addRow(["生成时间", manifest.generatedAt]);
    provenance.addRow([
      "产品选型版本",
      snapshot.scope.revision,
      snapshot.scope.status,
    ]);
    provenance.addRow([
      "所选产品",
      snapshot.scope.selected.map((p) => `${p.name} ${p.version}`).join("、"),
    ]);
    provenance.addRow(["售前策略", snapshot.scope.strategy]);
    for (const d of snapshot.sourceCoverage ?? []) {
      provenance.addRow([
        "原文覆盖",
        d.name,
        `${coverageLabel(d.status)}；未检查行 ${d.uncheckedLines.join("、")}`,
      ]);
      for (const entry of d.entries)
        provenance.addRow([
          entry.id,
          `L${entry.lineStart}-L${entry.lineEnd} ${entry.status}`,
          `${entry.reason}；关联 ${entry.requirementIds.join("、")} / ${entry.subrequirementIds.join("、")}`,
        ]);
    }
    provenance.addRow(["条款", "结果版本", "结论来源"]);
    manifest.requirements.forEach((r) =>
      provenance.addRow([r.id, r.revision, r.source]),
    );
    manifest.evidence.forEach((p) => provenance.addRow([p.id, p.path, p.hash]));
    provenance.addRow(["销售项", "产品版本 / 模块 ID", "关联条款 / 快照"]);
    manifest.sales.forEach((s) =>
      provenance.addRow([
        s.title,
        `${s.product} ${s.version} / ${s.moduleId}`,
        `${s.requirements.join("、")} / ${s.snapshotId}`,
      ]),
    );
    styleTable(provenance, [36, 64, 64]);
    if (kind === "sales") book.removeWorksheet(sheet.id);
    buffer = Buffer.from(await book.xlsx.writeBuffer());
  } else if (format === "csv") {
    buffer = Buffer.from(
      "\ufeff" +
        [headers, ...details]
          .map((row) =>
            row.map((v) => `"${safeCell(v).replaceAll('"', '""')}"`).join(","),
          )
          .join("\r\n"),
      "utf8",
    );
  } else {
    buffer = Buffer.from(renderReportHtml(snapshot, id), "utf8");
  }
  const dir = resolve(config.dataDir, "artifacts");
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, storageName), buffer, { flag: "wx" });
  await db.query(
    "INSERT INTO artifacts(id,project_id,name,storage_name,format,manifest) VALUES($1,$2,$3,$4,$5,$6)",
    [id, projectId, name, storageName, format, JSON.stringify(manifest)],
  );
  return { id, name, url: `/api/artifacts/${id}`, manifest };
}
