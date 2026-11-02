import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssessmentInput } from "../shared/domain.js";
import { canReviewInline, reviewRisks } from "../server/assessment-review.js";

function ordinary() {
  return {
    level: "exact",
    evidence: [{}],
    dependencies: [],
    mustSelect: [],
    selfReview: {
      completed: true,
      reason: "已核对方向范围场景及原生交付证据",
      checks: {},
    },
    verification: {
      checks: [
        {
          level: "exact",
          delivery: "native",
          deliveryConfirmed: true,
          evidence: [{}],
        },
      ],
      contributions: [{ product: "产品A", purpose: "purchase" }],
      integrationRequired: false,
      integrations: [],
    },
  } as unknown as AssessmentInput;
}

test("简单明确条款必须显式自检，编号不当作参数", () => {
  const item = ordinary();
  assert.equal(canReviewInline(item, "1. 支持实时预览"), true);
  delete item.selfReview;
  assert.equal(canReviewInline(item, "支持实时预览"), false);
});

test("参数、否定、缺口和跨产品等风险不能直接完成复核", () => {
  for (const raw of ["支持128路预览", "不得自动删除", "除非管理员审批"]) {
    assert.equal(canReviewInline(ordinary(), raw), false);
  }
  const variants = [
    (i: AssessmentInput) => {
      i.level = "unknown";
    },
    (i: AssessmentInput) => {
      i.verification!.integrationRequired = true;
    },
    (i: AssessmentInput) => {
      i.verification!.checks[0].delivery = "customization";
    },
    (i: AssessmentInput) => {
      i.verification!.checks[0].deliveryConfirmed = false;
    },
    (i: AssessmentInput) => {
      i.verification!.checks[0].evidence = [];
    },
    (i: AssessmentInput) => {
      i.verification!.contributions[0].purpose = "dependency";
    },
    (i: AssessmentInput) => {
      i.verification!.contributions.push({
        ...i.verification!.contributions[0],
        product: "产品B",
      });
    },
  ];
  for (const change of variants) {
    const item = ordinary();
    change(item);
    assert(reviewRisks(item, "支持实时预览").length);
    assert.equal(canReviewInline(item, "支持实时预览"), false);
  }
});
