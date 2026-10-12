import ExcelJS from "exceljs";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "./db.js";
import { assessmentRows } from "./assessment.js";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { collectSales, salesHeaders } from "./sale-entity.js";
import { productScope } from "./product-scope.js";
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
export async function createReport(
  db: Database,
  projectId: string,
  format: "xlsx" | "csv" | "html",
  kind: "full" | "sales" = "full",
) {
  if (kind === "sales" && format !== "xlsx")
    throw new AppError(400, "销售项清单使用 XLSX 模板格式");
  const snapshot = await db.transaction(async (tx) => {
    const [project] = await tx.query<{ name: string; wiki_project_id: string }>(
      "SELECT name,wiki_project_id FROM projects WHERE id=$1",
      [projectId],
    );
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
    const selectedSales = new Set(rows.flatMap((r) => r.sales));
    const missing = [
      ...new Set(
        rows
          .flatMap((r) => [...r.dependencies, ...r.mustSelect])
          .filter((name) => !selectedSales.has(name)),
      ),
    ];
    if (missing.length)
      throw new AppError(
        409,
        `销售项清单缺少交付依赖或必选项：${missing.join("、")}，请补充匹配与证据后导出`,
      );
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
      scope: await productScope(tx, projectId),
    };
  });
  const { project, rows, pages, docs } = snapshot;
  const sales = collectSales(rows, pages);
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
  ];
  const details = rows.flatMap((row) =>
    (row.sales.length ? row.sales : ["—"]).map((sale) => [
      row.requirementId,
      row.module,
      row.requirement_raw,
      sale,
      row.evidence.map((e) => e.quote).join("\n"),
      row.level,
      row.ok.join("\n"),
      row.hard.join("\n"),
      row.no.join("\n"),
      row.note,
      row.evidence
        .map(
          (e) =>
            `${pages.find((p) => p.id === e.snapshotId)?.path ?? e.snapshotId}:L${e.lineStart}-L${e.lineEnd} [${e.snapshotId}]`,
        )
        .join("\n"),
    ]),
  );
  const id = randomUUID();
  const name = `${project.name}-${kind === "sales" ? "销售项清单" : "评估报告"}.${format}`;
  const storageName = `${id}.${format}`;
  const manifest = {
    projectId,
    wikiProjectId: project.wiki_project_id,
    generatedAt: new Date().toISOString(),
    kind,
    productScope: snapshot.scope,
    sales: sales.map(({ entity, page, requirements }) => ({
      title: entity.title,
      product: entity.product,
      version: entity.version,
      moduleId: entity.moduleId,
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
        rows.some((r) => r.evidence.some((e) => e.snapshotId === p.id)),
      )
      .map(({ content, ...rest }) => rest),
  };
  let buffer: Buffer;
  if (format === "xlsx") {
    const book = new ExcelJS.Workbook();
    book.creator = "标研";
    book.created = new Date();
    const sheet = book.addWorksheet("功能点匹配报告", {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    sheet.addRow(headers);
    details.forEach((row) => sheet.addRow(row.map(safeCell)));
    sheet.columns.forEach((col, index) => {
      col.width = [2, 4, 9, 10].includes(index) ? 50 : 22;
    });
    sheet.eachRow((row, index) => {
      row.alignment = { vertical: "top", wrapText: true };
      row.eachCell((cell) => {
        cell.font = { name: "微软雅黑", size: 10 };
        if (index === 1) {
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFD9E1F2" },
          };
          cell.font = { name: "微软雅黑", bold: true, size: 10 };
        } else {
          const level = row.getCell(6).value;
          if (level === "partial" || level === "no_match")
            cell.fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: level === "partial" ? "FFFFEB9C" : "FFFFC7CE" },
            };
        }
      });
    });
    sheet.eachRow((row, index) => {
      if (index === 1) return;
      const assessment = rows.find(
        (r) => r.requirementId === row.getCell(1).value,
      );
      const words = [
        ...new Set(
          assessment?.ok.filter(
            (word) => word.length > 1 && word.length < 100,
          ) ?? [],
        ),
      ].sort((a, b) => b.length - a.length);
      if (!words.length) return;
      const text = String(row.getCell(5).value ?? "");
      const pattern = new RegExp(
        `(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
        "g",
      );
      row.getCell(5).value = {
        richText: text
          .split(pattern)
          .filter(Boolean)
          .map((part) => ({
            text: part,
            font: words.includes(part)
              ? { bold: true, color: { argb: "FFCC0000" } }
              : { name: "微软雅黑", size: 10 },
          })),
      };
    });
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: 11 },
    };
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
    salesSheet.columns.forEach(
      (col, index) =>
        (col.width =
          index === 4 ? 110 : index === 9 ? 80 : index === 1 ? 30 : 22),
    );
    salesSheet.eachRow((row, index) => {
      row.alignment = { vertical: "top", wrapText: true };
      row.font = { name: "等线", size: 11, bold: index === 1 };
      const wrappedLines =
        index === 1
          ? 1
          : Math.max(
              ...Array.from({ length: 10 }, (_, i) => {
                const text = String(row.getCell(i + 1).value ?? "");
                const width = salesSheet.getColumn(i + 1).width ?? 22;
                return text
                  .split("\n")
                  .reduce(
                    (sum, line) =>
                      sum +
                      Math.max(
                        1,
                        Math.ceil(
                          [...line].reduce(
                            (n, c) => n + (/[\u3000-\u9fff]/.test(c) ? 2 : 1),
                            0,
                          ) / width,
                        ),
                      ),
                    0,
                  );
              }),
            );
      row.height =
        index === 1 ? 28 : Math.min(409, Math.max(48, wrappedLines * 16 + 12));
      row.eachCell((cell) => {
        cell.border = {
          top: { style: "thin", color: { argb: "FFD9DFDC" } },
          bottom: { style: "thin", color: { argb: "FFD9DFDC" } },
          left: { style: "thin", color: { argb: "FFD9DFDC" } },
          right: { style: "thin", color: { argb: "FFD9DFDC" } },
        };
      });
    });
    salesSheet.autoFilter = "A1:J1";
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
    provenance.columns.forEach((c) => (c.width = 45));
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
    const stats = ["exact", "partial", "no_match"]
      .map(
        (level) =>
          `${{ exact: "完全满足", partial: "部分满足", no_match: "不满足" }[level]} ${rows.filter((r) => r.level === level).length}`,
      )
      .join(" · ");
    const body = details
      .map(
        (row) =>
          `<tr class="${row[5]}">${row.map((v) => `<td>${escapeHtml(v)}</td>`).join("")}</tr>`,
      )
      .join("");
    buffer = Buffer.from(
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(project.name)} · 评估报告</title><style>body{font:14px/1.7 sans-serif;margin:32px;color:#24352f}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:10px;white-space:pre-wrap;vertical-align:top}th{background:#edf3f0}.partial{background:#fff8dc}.no_match{background:#ffe9e7}pre{white-space:pre-wrap;font-size:11px}h1{font-size:26px}@media print{body{margin:0}}</style><h1>${escapeHtml(project.name)} · 招标评估报告</h1><p>${escapeHtml(stats)}</p><p>报告 ID：${id} · 生成时间：${escapeHtml(manifest.generatedAt)}</p><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table><h2>销售项清单</h2><table><thead><tr>${salesHeaders.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${saleRows.map((row) => `<tr>${row.map((v) => `<td>${escapeHtml(v)}</td>`).join("")}</tr>`).join("")}</tbody></table><h2>五项依据</h2>${rows.map((r) => `<h3>${r.requirementId}</h3><pre>${escapeHtml(JSON.stringify(r.criteria, null, 2))}</pre>`).join("")}<h2>追溯信息</h2><pre>${escapeHtml(JSON.stringify(manifest, null, 2))}</pre></html>`,
    );
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
