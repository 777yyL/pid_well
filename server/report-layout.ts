import type ExcelJS from "exceljs";
import type { ReportSnapshot } from "./reports.js";
import { escapeHtml, safeCell } from "./reports.js";
import { collectSales } from "./sale-entity.js";

export const verdictLabels = {
  exact: "完全满足",
  partial: "部分满足",
  no_match: "不满足",
} as const;
const tones: Record<string, [string, string]> = {
  完全满足: ["EAF5EE", "176B42"],
  部分满足: ["FFF4DC", "875000"],
  不满足: ["FFF0EE", "A21D15"],
};
const cellText = (cell: ExcelJS.Cell) =>
  typeof cell.value === "object" && cell.value && "richText" in cell.value
    ? cell.value.richText.map((part) => part.text).join("")
    : cell.text;
const linesFor = (text: string, width: number) =>
  text
    .split("\n")
    .reduce(
      (sum, line) =>
        sum +
        Math.max(
          1,
          Math.ceil(
            [...line].reduce(
              (n, c) => n + (/[^\x00-\x7f]/.test(c) ? 2 : 1),
              0,
            ) / Math.max(8, width - 2),
          ),
        ),
      0,
    );

export function styleTable(
  sheet: ExcelJS.Worksheet,
  widths: number[],
  verdictColumn?: number,
) {
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });
  sheet.views = [
    { state: "frozen", ySplit: 1, xSplit: 1, showGridLines: false },
  ];
  sheet.properties.defaultRowHeight = 28;
  sheet.pageSetup = {
    paperSize: 9,
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printTitlesRow: "1:1",
    margins: {
      left: 0.3,
      right: 0.3,
      top: 0.5,
      bottom: 0.5,
      header: 0.2,
      footer: 0.2,
    },
  };
  sheet.headerFooter.oddFooter = "&L评标AI · 售前评估&R第 &P 页 / 共 &N 页";
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, sheet.rowCount), column: widths.length },
  };
  sheet.eachRow((row, index) => {
    let height = 28;
    row.eachCell({ includeEmpty: true }, (cell, column) => {
      if (typeof cell.value === "string") cell.value = safeCell(cell.value);
      cell.font = {
        name: "微软雅黑",
        size: 11,
        color: { argb: "FF24352F" },
        bold: index === 1,
      };
      cell.alignment = {
        vertical: "top",
        wrapText: true,
        indent: index === 1 ? 0 : 1,
      };
      cell.border = { bottom: { style: "thin", color: { argb: "FFD8E2DD" } } };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: {
          argb:
            index === 1
              ? "FF224D3D"
              : index % 2 === 0
                ? "FFF3F7F4"
                : "FFFFFFFF",
        },
      };
      if (index === 1) {
        cell.font.color = { argb: "FFFFFFFF" };
        cell.alignment.vertical = "middle";
      }
      height = Math.max(
        height,
        linesFor(cellText(cell), widths[column - 1] ?? 30) * 16 + 16,
      );
    });
    row.height = index === 1 ? 34 : Math.min(390, height);
    if (index > 1 && verdictColumn) {
      const cell = row.getCell(verdictColumn),
        tone = tones[cell.text];
      if (tone) {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: `FF${tone[0]}` },
        };
        cell.font = {
          name: "微软雅黑",
          size: 11,
          bold: true,
          color: { argb: `FF${tone[1]}` },
        };
        cell.alignment = {
          vertical: "middle",
          horizontal: "center",
          wrapText: true,
        };
      }
    }
  });
}

export function addOverview(
  book: ExcelJS.Workbook,
  snapshot: ReportSnapshot,
  salesCount: number,
) {
  const sheet = book.addWorksheet("评估概览", {
    views: [{ showGridLines: false }],
    properties: { tabColor: { argb: "FF224D3D" } },
  });
  for (let i = 1; i <= 8; i++) sheet.getColumn(i).width = 17;
  const band = (
    range: string,
    text: string,
    fill: string,
    size = 12,
    color = "FFFFFF",
  ) => {
    sheet.mergeCells(range);
    const cell = sheet.getCell(range.split(":")[0]);
    cell.value = safeCell(text);
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: `FF${fill}` },
    };
    cell.font = {
      name: "微软雅黑",
      size,
      bold: true,
      color: { argb: `FF${color}` },
    };
    cell.alignment = { vertical: "middle", wrapText: true };
  };
  band("A1:H2", `${snapshot.project.name} · 招标评估报告`, "224D3D", 22);
  band(
    "A3:H3",
    `生成时间：${new Date(snapshot.generatedAt).toLocaleString("zh-CN")}　｜　全部条款已确认并复核`,
    "EDF4EF",
    11,
    "425B4D",
  );
  sheet.getRow(1).height = 30;
  sheet.getRow(2).height = 24;
  sheet.getRow(3).height = 30;
  const stats = [
    ["技术条款", snapshot.rows.length, "EDF4EF", "24352F"],
    ...Object.entries(verdictLabels).map(([level, label]) => [
      label,
      snapshot.rows.filter((r) => r.level === level).length,
      ...tones[label],
    ]),
  ];
  stats.forEach(([label, count, fill, color], index) => {
    const col = String.fromCharCode(65 + index * 2),
      next = String.fromCharCode(66 + index * 2);
    band(`${col}5:${next}5`, String(label), String(fill), 12, String(color));
    band(`${col}6:${next}7`, String(count), String(fill), 26, String(color));
  });
  sheet.getRow(5).height = 26;
  sheet.getRow(6).height = 28;
  sheet.getRow(7).height = 26;
  band("A9:H9", `产品与交付范围　｜　销售项 ${salesCount} 项`, "224D3D");
  sheet.getRow(9).height = 30;
  const products = [
    ...new Set(snapshot.rows.map((r) => `${r.product} ${r.version}`.trim())),
  ].join("、");
  band("A10:H11", products, "F3F7F4", 12, "24352F");
  sheet.getRow(10).height = 30;
  sheet.getRow(11).height = 30;
  band(
    "A12:H13",
    snapshot.scope.strategy ||
      "评估以原始条款、产品证据和人工确认结果为准；数量与授权范围由销售核定。",
    "F3F7F4",
    11,
    "526171",
  );
  sheet.getRow(12).height = 30;
  sheet.getRow(13).height = 30;
  band(
    "A15:H15",
    "重点缺口与交付条件（列示前10项，完整结果见匹配报告）",
    "224D3D",
  );
  sheet.getRow(15).height = 30;
  const risks = snapshot.rows.filter((r) => r.level !== "exact").slice(0, 10);
  (risks.length ? risks : [undefined]).forEach((row, i) => {
    const n = 16 + i;
    sheet.mergeCells(`B${n}:D${n}`);
    sheet.mergeCells(`E${n}:H${n}`);
    sheet.getCell(`A${n}`).value = row?.requirementId ?? "—";
    sheet.getCell(`B${n}`).value = safeCell(
      row?.requirement_raw ?? "未记录部分满足或不满足条款",
    );
    sheet.getCell(`E${n}`).value = safeCell(
      row
        ? [...row.hard, ...row.no, row.note].filter(Boolean).join("\n")
        : "详见逐条匹配报告与原始证据。",
    );
    sheet.getRow(n).eachCell((cell) => {
      cell.font = { name: "微软雅黑", size: 11, color: { argb: "FF24352F" } };
      cell.alignment = { wrapText: true, vertical: "top" };
    });
    sheet.getRow(n).height = Math.min(
      390,
      Math.max(
        64,
        linesFor(sheet.getCell(`B${n}`).text, 48) * 16 + 16,
        linesFor(sheet.getCell(`E${n}`).text, 65) * 16 + 16,
      ),
    );
  });
  sheet.pageSetup = {
    paperSize: 9,
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
  };
}

export function addSalesDetails(
  book: ExcelJS.Workbook,
  sales: ReturnType<typeof collectSales>,
  main: ExcelJS.Worksheet,
) {
  const sheet = book.addWorksheet("销售项技术明细");
  sheet.addRow(["序号", "销售项名称", "内容类别", "完整原文（按段连续阅读）"]);
  sales.forEach(({ entity }, index) => {
    const start = sheet.rowCount + 1;
    for (const [label, value] of [
      ["技术规格", entity.specification],
      ["销售项描述", entity.description],
      ["报价说明", entity.quotation],
      ["依赖说明", entity.dependencyNote],
      ["清单备注", main.getRow(index + 2).getCell(10).text],
    ]) {
      const chars = [...(value || "知识库未提供")];
      for (let offset = 0; offset < chars.length; offset += 320)
        sheet.addRow([
          index + 1,
          safeCell(entity.title),
          label,
          safeCell(chars.slice(offset, offset + 320).join("")),
        ]);
    }
    const row = main.getRow(index + 2);
    for (const column of [5, 10]) {
      const text = row.getCell(column).text;
      if (text.length > 380)
        row.getCell(column).value = {
          text: `${[...text].slice(0, 180).join("")}…\n完整原文见「销售项技术明细」；关联与版本见「证据与版本」。`,
          hyperlink: `#'销售项技术明细'!A${start}`,
        };
    }
  });
  styleTable(sheet, [9, 32, 16, 100]);
}

export function renderReportHtml(snapshot: ReportSnapshot, id: string) {
  const e = escapeHtml;
  const sales = collectSales(snapshot.rows, snapshot.pages);
  const list = (items: string[]) =>
    items.length
      ? `<ul>${items.map((item) => `<li>${e(item)}</li>`).join("")}</ul>`
      : "<p class='muted'>未记录</p>";
  const criteriaNames: Record<string, string> = {
    direction: "能力方向",
    scope: "能力边界",
    spec: "规格参数",
    context: "场景适配",
    delivery: "交付约束",
  };
  const cards = snapshot.rows
    .map(
      (row) =>
        `<article class="assessment ${row.level}"><header><b>${e(row.requirementId)} · ${e(row.module)}</b><span class="badge ${row.level}">${verdictLabels[row.level]}</span></header><h3>招标原文</h3><blockquote class="source">${e(row.requirement_raw)}</blockquote><p class="product">${e(row.product)} ${e(row.version)}　｜　${e(row.sales.join("、") || "未找到对应销售项")}</p><h3>结论说明</h3><p>${e(row.note)}</p><div class="findings"><section class="exact"><h4>已具备</h4>${list(row.ok)}</section><section class="partial"><h4>需配置 / 定制</h4>${list(row.hard)}</section><section class="no_match"><h4>明确缺口</h4>${list(row.no)}</section></div><h3>五项判断依据</h3><dl>${Object.entries(
          row.criteria,
        )
          .map(
            ([key, value]) =>
              `<div><dt>${criteriaNames[key] || e(key)}</dt><dd>${e(value)}</dd></div>`,
          )
          .join(
            "",
          )}</dl><h3>知识库原始证据</h3>${row.evidence.map((proof) => `<div class="evidence"><blockquote>${e(proof.quote)}</blockquote><small>${e(snapshot.pages.find((page) => page.id === proof.snapshotId)?.path)} · L${proof.lineStart}–L${proof.lineEnd}</small></div>`).join("") || "<p class='muted'>未记录对应产品证据</p>"}<p class="muted">交付依赖：${e(row.dependencies.join("、") || "未列出")}　｜　必选项：${e(row.mustSelect.join("、") || "未列出")}　｜　${row.source === "human" ? "人工确认" : "AI 已复核"} · 结果版本 ${row.revision}</p></article>`,
    )
    .join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(snapshot.project.name)} · 评估报告</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f0f3f1;color:#24352f;font:14px/1.8 'Microsoft YaHei','Segoe UI',sans-serif}main{max-width:1160px;margin:36px auto;padding:0 24px}h1{font-size:30px;line-height:1.4;margin:0 0 12px}h2{font-size:22px;margin:36px 0 16px}h3{font-size:15px;margin:22px 0 8px}h4{margin:0 0 8px}p{white-space:pre-wrap;margin:8px 0}.cover{padding:32px;background:#224d3d;color:white;border-radius:12px}.cover small{color:#d1e5d7}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:22px 0}.stat,.assessment,.sale{padding:24px;background:#fff;border:1px solid #c8d6ce;border-radius:10px;margin:16px 0}.stat{margin:0}.stat b{display:block;font-size:30px}.exact{color:#176b42;background:#eaf5ee}.partial{color:#875000;background:#fff4dc}.no_match{color:#a21d15;background:#fff0ee}.assessment{color:#24352f;background:white;border-left:5px solid}.assessment.exact{border-left-color:#176b42}.assessment.partial{border-left-color:#ad6500}.assessment.no_match{border-left-color:#b42318}header{display:flex;align-items:center;justify-content:space-between;gap:16px}.badge{padding:4px 14px;border-radius:5px;font-weight:bold;white-space:nowrap}blockquote{margin:10px 0;padding:14px 18px;white-space:pre-wrap;overflow-wrap:anywhere}.source{border-left:3px solid #ad6500;background:#fff7e8}.evidence{padding:14px 18px;background:#f0f5fc;border-left:3px solid #245c9f;margin:12px 0;color:#243b58}.evidence blockquote{padding:0}.muted{color:#526171;font-size:12px}.findings{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.findings section{padding:16px;border-radius:6px}ul{margin:0;padding-left:20px}dl>div{display:grid;grid-template-columns:100px 1fr;border-bottom:1px solid #e1e8e3;padding:10px 0}dt{color:#526171}dd{margin:0;white-space:pre-wrap}.product{font-weight:bold}.sale-spec{white-space:pre-wrap}.toc{padding:16px 0}a{color:#245c9f}.sale header{font-size:17px}.sale dl{display:grid;grid-template-columns:1fr 1fr;gap:0 24px}.sale dl>div{grid-template-columns:80px 1fr}@media(max-width:700px){main{padding:0 14px;margin:16px auto}.stats{grid-template-columns:repeat(2,1fr)}.findings,.sale dl{grid-template-columns:1fr}.cover{padding:22px}h1{font-size:24px}}@media print{@page{size:A4;margin:14mm}body{background:white;font-size:11px}main{margin:0;padding:0}.cover,.stats,.evidence,.badge,.findings{-webkit-print-color-adjust:exact;print-color-adjust:exact}.assessment,.sale{border-radius:0;break-before:auto}.findings section,.evidence,dl>div{break-inside:avoid}h2,h3,header{break-after:avoid}.toc{display:none}}
  </style></head><body><main><section class="cover"><small>评标AI · 售前评估成果</small><h1>${e(snapshot.project.name)}</h1><p>招标评估报告</p><small>生成时间：${e(new Date(snapshot.generatedAt).toLocaleString("zh-CN"))} · 报告编号 ${e(id)}</small></section><div class="stats"><div class="stat"><span>技术条款 / 销售项</span><b>${snapshot.rows.length} / ${sales.length}</b></div>${Object.entries(
    verdictLabels,
  )
    .map(
      ([level, label]) =>
        `<div class="stat ${level}"><span>${label}</span><b>${snapshot.rows.filter((row) => row.level === level).length}</b></div>`,
    )
    .join(
      "",
    )}</div><p class="muted">全部条款已确认并复核。数量、授权范围及未提供的报价字段仍需销售核定。</p><nav class="toc"><a href="#assessments">逐条评估</a>　·　<a href="#sales">销售项清单</a></nav><h2>产品范围与评估策略</h2><p>${e([...new Set(snapshot.rows.map((row) => `${row.product} ${row.version}`))].join("、"))}</p><p>${e(snapshot.scope.strategy || "依据招标原文、知识库证据和人工确认结果评估。")}</p><h2>重点缺口与交付条件</h2>${list(snapshot.rows.filter((row) => row.level !== "exact").map((row) => `${row.requirementId} · ${[...row.hard, ...row.no, row.note].filter(Boolean).join("；")}`))}<h2 id="assessments">逐条匹配与证据</h2>${cards}<h2 id="sales">销售项清单 · ${sales.length} 项</h2>${sales
    .map(
      ({ entity, requirements }, index) =>
        `<article class="sale"><header><b>${index + 1}. ${e(entity.title)}</b><span class="muted">${e(entity.product)} ${e(entity.version)}</span></header><dl>${[
          ["产品类别", entity.category],
          ["型号", entity.moduleId],
          ["单位", entity.unit],
          ["数量", entity.quantity ?? "待销售核定"],
          ["单价", entity.price ?? "知识库未提供"],
          [
            "合价",
            entity.total ??
              (entity.quantity !== undefined && entity.price !== undefined
                ? entity.quantity * entity.price
                : "待核定"),
          ],
        ]
          .map(
            ([key, value]) =>
              `<div><dt>${e(key)}</dt><dd>${e(value)}</dd></div>`,
          )
          .join(
            "",
          )}</dl><h3>技术规格（完整原文）</h3><p class="sale-spec">${e(entity.specification || "知识库未提供")}</p><h3>报价与交付说明</h3><p>${e([entity.description, entity.quotation, entity.dependencyNote && `依赖：${entity.dependencyNote}`, entity.mandatory && `必选：${entity.mandatory}`].filter(Boolean).join("\n"))}</p><p class="muted">关联条款：${e([...requirements].join("、"))}</p></article>`,
    )
    .join(
      "",
    )}<footer class="muted">本报告固定生成时的结果、证据和版本。人工确认结果优先；正式投标响应需由售前和交付团队核验。</footer></main></body></html>`;
}
