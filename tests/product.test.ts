import { test } from "node:test";
import assert from "node:assert/strict";
import { malformedToolText } from "../shared/agent-protocol.js";
import ExcelJS from "exceljs";
test("工具协议文本不执行，正常讨论协议名称不误判", () => {
  assert(
    malformedToolText(
      '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="save_requirements">',
    ),
  );
  assert(
    malformedToolText('<tool_call>{"name":"save_requirements"}</tool_call>'),
  );
  assert(!malformedToolText("DSML 兼容性需要检查，请使用标准工具调用。"));
  assert(!malformedToolText("请确认 205 条已保存需求后继续。"));
});
import {
  parseSaleEntity,
  collectSales,
  salesHeaders,
  entitySection,
} from "../server/sale-entity.js";
import {
  mergeRanges,
  recentContext,
  updateReadRanges,
  emptyCheckpoint,
} from "../server/context-memory.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const spec =
  "重点区域人员进出管控主要是在某些重点区域场景中，对人员的进出进行严格管控，包括多重认证、多门互锁、反潜回应用。 【功能介绍】 一、提供多重认证应用 设置为多重认证的门，需要认证分组内的成员按照一定的规则进行认证开门： 1、支持前端设备认证，认证分组内的成员按照设定的认证顺序在设备上完成认证开门； 2、支持前端设备认证+中心远程开门，认证分组内的成员按照设定的认证顺序在设备上完成认证后，中心操作人员可以直接远程开门或要求中心操作人员通过刷卡/指纹/人脸认证后远程开门； 3、支持前端设备认证+超级权限认证开门，认证分组内的成员按照设定的认证顺序在设备上完成认证后，再通过刷超级卡或输入超级密码认证后开门； 二、提供多门互锁应用 在配置为多门互锁的门中，最多只能开启一扇门，且其他门必须处于关闭状态时才能开启这扇门，支持单机多门互锁（单个26系列控制器下门之间的互锁）和跨主机多门互锁（多个26系列控制器下门之间的互锁）； 三、提供反潜回应用 反潜回是一种防尾随功能，要求持卡者从某个门刷卡进来就必须从某个门刷卡出去，刷卡记录必须一进一出严格对应。支持单机反潜回（单个26系列控制器下门的反潜回）和跨主机反潜回（多个26系列控制器下门的反潜回）。 【性能规格】 1、多重认证分组：单个门最多支持32个； 2、多门互锁：单个门禁控制器最多支持4门互锁； 3、反潜回：单个门禁控制器最多支持4个门反潜回；跨门禁控制器最多支持128个门反潜回。";
const sample = `# 重点区域人员门禁管控
> 产品 [aiotpnp](http://tauri.localhost/#aiotpnp) v2.1.0 · 分类 人员通行 · 来源 AIoTPNP_2.1.0.xlsx
- 模块ID: \`PNP IOC-ACS_key area\`
- 单位: 套 ｜ 固定价: 5000 ｜ 必选: 否
- 报价说明: 重点区域人员门禁管控特性收费5000元/套。无其他额外授权费用。
- 依赖销售项: 门禁管理
**销售项描述**
重点区域人员进出管控，包括多重认证、多门互锁、反潜回应用。
**技术规格**
${spec}`;
test("线上实体格式：报价、依赖、分类与完整性能规格", () => {
  const item = parseSaleEntity(sample);
  assert.equal(item.title, "重点区域人员门禁管控");
  assert.equal(item.product, "aiotpnp");
  assert.equal(item.version, "v2.1.0");
  assert.equal(item.category, "人员通行");
  assert.equal(item.moduleId, "PNP IOC-ACS_key area");
  assert.equal(item.price, 5000);
  assert.equal(item.unit, "套");
  assert.equal(item.mandatory, "否");
  assert.deepEqual(item.dependencies, ["门禁管理"]);
  assert.equal(item.specification, spec);
  assert(item.quotation.includes("无其他额外授权费用"));
  assert.equal(item.quantity, undefined);
  assert.equal(
    entitySection(
      "## 技术规格\n第一行\n第二行\n## 其他\n不属于规格",
      "技术规格",
    ),
    "第一行\n第二行",
  );
});
test("销售清单按实体去重，检查依赖和快照冲突", () => {
  const page = {
    id: "a",
    path: "wiki/entities/access.md",
    content: sample,
    hash: "a",
  };
  const match = {
    sales: ["重点区域人员门禁管控"],
    product: "aiotpnp",
    version: "v2.1.0",
    requirementId: "T-1",
    evidence: [{ snapshotId: "a" }],
  };
  assert.throws(() => collectSales([match], [page]), /交付依赖/);
  const base = {
    id: "b",
    path: "wiki/entities/base.md",
    hash: "b",
    content:
      "---\ntitle: 门禁管理\nproduct: aiotpnp\nversion: v2.1.0\nmodule_id: BASE\n---\n## 技术规格\n管理门禁",
  };
  const rows = [
    match,
    { ...match, requirementId: "T-2" },
    { ...match, sales: ["门禁管理"], evidence: [{ snapshotId: "b" }] },
  ];
  const result = collectSales(rows, [page, base]);
  assert.equal(result.length, 2);
  assert.deepEqual([...result[0].requirements], ["T-1", "T-2"]);
  const linked = {
    ...page,
    content: sample.replace(
      "依赖销售项: 门禁管理",
      "依赖销售项: [[base|门禁管理]]（扩展联动建议 [[optional]]）",
    ),
  };
  assert.deepEqual(parseSaleEntity(linked.content).dependencies, ["base"]);
  assert.equal(collectSales(rows, [linked, base]).length, 2);
  assert.deepEqual(
    parseSaleEntity(
      sample.replace("依赖销售项: 门禁管理", "依赖销售项: 无（根销售项）"),
    ).dependencies,
    [],
  );
  assert.throws(
    () =>
      collectSales(
        [{ ...match, evidence: [{ snapshotId: "a" }, { snapshotId: "c" }] }],
        [
          page,
          { ...page, id: "c", hash: "c", content: sample + "\n新内容" },
          base,
        ],
      ),
    /多个内容版本/,
  );
});
test("模板列顺序一致，阅读区间和工具消息组压缩保持完整", async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile("sps销售项清单模板.xlsx");
  assert.deepEqual(
    Array.from(
      { length: 10 },
      (_, i) => workbook.worksheets[0].getRow(1).getCell(i + 1).value,
    ),
    salesHeaders,
  );
  assert.deepEqual(
    mergeRanges([
      [100, 200],
      [1, 50],
      [51, 120],
      [300, 310],
    ]),
    [
      [1, 200],
      [300, 310],
    ],
  );
  const checkpoint = emptyCheckpoint();
  const messages = [
    { role: "user", content: "不覆盖人工结果", timestamp: 1 },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "r",
          name: "read_document",
          arguments: { documentId: "doc", start: 101, count: 250 },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "r",
      toolName: "read_document",
      isError: false,
      content: [
        { type: "text", text: JSON.stringify({ total: 1736, text: "原文" }) },
      ],
      timestamp: 2,
    },
  ] as AgentMessage[];
  updateReadRanges(checkpoint, messages);
  assert.deepEqual(checkpoint.readRanges.doc, [[101, 350]]);
  updateReadRanges(checkpoint, [
    messages[1],
    { ...messages[2], isError: true },
  ] as AgentMessage[]);
  assert.deepEqual(checkpoint.readRanges.doc, [[101, 350]]);
  const recent = recentContext(messages, 100);
  assert.equal(recent[0].role, "user");
  assert.equal(recent[1].role, "assistant");
  assert.equal(recent[2].role, "toolResult");
});
