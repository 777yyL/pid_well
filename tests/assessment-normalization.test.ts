import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssessmentInput } from "../shared/domain.js";
import {
  normalizeAssessmentInput,
  normalizeAssessmentEvidence,
  normalizeProcurementNames,
} from "../server/assessment-normalization.js";

function item(quote: string, lineStart = 99, lineEnd = 99) {
  const evidence = { snapshotId: "snapshot", quote, lineStart, lineEnd };
  return {
    level: "partial",
    sales: ["候选"],
    evidence: [{ ...evidence }],
    verification: {
      checks: [{ evidence: [{ ...evidence }] }],
      integrations: [],
      contributions: [
        { sales: "门禁", purpose: "purchase", evidence: [{ ...evidence }] },
        { sales: "候选", purpose: "candidate", evidence: [] },
      ],
    },
  } as unknown as AssessmentInput;
}

test("只兼容单元素销售名称数组，不修改输入或猜测多名称", () => {
  const raw = [
    {
      verification: {
        contributions: [{ sales: ["门禁"] }, { sales: ["甲", "乙"] }],
      },
    },
  ];
  const normalized = normalizeAssessmentInput(raw) as typeof raw;
  assert.equal(normalized[0].verification.contributions[0].sales, "门禁");
  assert.deepEqual(normalized[0].verification.contributions[1].sales, [
    "甲",
    "乙",
  ]);
  assert.deepEqual(raw[0].verification.contributions[0].sales, ["门禁"]);
});

test("唯一原文定位修正全部重复引用，保留跨行原文与换行", () => {
  const assessment = item("支持  跨控制器 反潜回");
  normalizeAssessmentEvidence(
    assessment,
    new Map([["snapshot", "# 门禁\n支持 跨控制器\n反潜回\n"]]),
  );
  for (const e of [
    assessment.evidence[0],
    assessment.verification!.checks[0].evidence[0],
    assessment.verification!.contributions[0].evidence[0],
  ]) {
    assert.equal(e.lineStart, 2);
    assert.equal(e.lineEnd, 3);
    assert.equal(e.quote, "支持 跨控制器\n反潜回");
  }
});

test("歧义、改写、其他快照不修正，合法大范围摘句仍保留", () => {
  for (const [content, quote] of [
    ["支持门禁\n支持门禁", "支持门禁"],
    ["不支持门禁", "完全支持门禁"],
  ]) {
    const assessment = item(quote);
    normalizeAssessmentEvidence(assessment, new Map([["snapshot", content]]));
    assert.equal(assessment.evidence[0].lineStart, 99);
  }
  const assessment = item("支持门禁", 1, 3);
  normalizeAssessmentEvidence(
    assessment,
    new Map([["snapshot", "标题\n支持门禁\n结束"]]),
  );
  assert.equal(assessment.evidence[0].lineStart, 1);
  assert.equal(assessment.evidence[0].lineEnd, 3);
  normalizeAssessmentEvidence(assessment, new Map([["other", "支持门禁"]]));
  assert.equal(assessment.evidence[0].lineStart, 1);
});

test("正式清单按贡献目的生成，不升级候选或改写unknown结论", () => {
  const assessment = item("证据");
  normalizeProcurementNames(assessment);
  assert.deepEqual(assessment.sales, ["门禁"]);
  assessment.level = "unknown";
  normalizeProcurementNames(assessment);
  assert.deepEqual(assessment.sales, []);
  assert.equal(assessment.verification!.contributions[0].purpose, "purchase");
  assessment.sales = ["伪造销售项"];
  normalizeProcurementNames(assessment);
  assert.deepEqual(
    assessment.sales,
    ["伪造销售项"],
    "交给原有实体校验拒绝，不能静默丢弃错误名称",
  );
});
