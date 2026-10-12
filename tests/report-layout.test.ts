import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { addSalesDetails, styleTable } from "../server/report-layout.js";
import type { collectSales } from "../server/sale-entity.js";
test("长规格与备注完整保留，主清单可读且数值和模板列不变", async () => {
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet("销售项清单");
  const specification =
    "【功能介绍】\n支持多重认证、多门互锁及反潜回；跨主机最多128个门。\n".repeat(
      50,
    );
  const remarks = "报价说明：按套授权，数量待核定。\n".repeat(40);
  sheet.addRow([
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
  ]);
  sheet.addRow([
    1,
    "重点区域人员门禁管控",
    "人员通行",
    "PNP IOC-ACS_key area",
    specification,
    "套",
    null,
    5000,
    null,
    remarks,
  ]);
  const sales: ReturnType<typeof collectSales> = [
    {
      entity: {
        title: "重点区域人员门禁管控",
        product: "AIoTPNP",
        version: "v2.1.0",
        category: "人员通行",
        moduleId: "PNP IOC-ACS_key area",
        specification,
        unit: "套",
        price: 5000,
        mandatory: "否",
        description: "重点区域人员通行",
        quotation: "按套授权",
        dependencies: [],
        dependencyNote: "门禁管理",
      },
      requirements: new Set(["T-1"]),
      page: {
        id: "fixture",
        path: "wiki/entities/access.md",
        content: "",
        hash: "fixture",
      },
    },
  ];
  addSalesDetails(book, sales, sheet);
  styleTable(sheet, [9, 30, 26, 28, 58, 9, 11, 15, 17, 58]);
  const bytes = await book.xlsx.writeBuffer(),
    restored = new ExcelJS.Workbook();
  await restored.xlsx.load(bytes);
  const main = restored.getWorksheet("销售项清单")!,
    detail = restored.getWorksheet("销售项技术明细")!;
  assert(main.getCell("E2").text.includes("完整原文见"));
  assert(main.getCell("E2").hyperlink.startsWith("#'销售项技术明细'!"));
  assert.equal(main.getCell("H2").value, 5000);
  assert.equal(main.getCell("G2").value, null);
  assert.equal(main.columnCount, 10);
  assert(main.getRow(2).height! < 390);
  let actualSpec = "",
    actualRemarks = "";
  detail.eachRow((row, index) => {
    if (index > 1 && row.getCell(3).text === "技术规格")
      actualSpec += row.getCell(4).text;
    if (index > 1 && row.getCell(3).text === "清单备注")
      actualRemarks += row.getCell(4).text;
  });
  assert.equal(actualSpec, specification);
  assert.equal(actualRemarks, remarks);
  assert(detail.getRow(2).height! < 390);
  assert.equal(main.pageSetup.printTitlesRow, "1:1");
});
