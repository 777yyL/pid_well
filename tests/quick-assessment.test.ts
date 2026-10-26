import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  buildQuickAssessment,
  parseQuickJudgments,
  planQuickBatches,
  type QuickPacket,
} from "../server/quick-assessment.js";

const packet = (): QuickPacket => ({
  requirement: {
    id: "T-1",
    documentId: randomUUID(),
    module: "门禁",
    type: "功能",
    raw: "支持跨控制器反潜回",
    lineStart: 1,
    lineEnd: 1,
    subrequirements: [
      {
        id: "T-1.1",
        raw: "支持跨控制器反潜回",
        required: true,
        lineStart: 1,
        lineEnd: 1,
      },
    ],
  },
  candidates: [
    {
      path: "wiki/entities/sale-items/access.md",
      snapshotId: randomUUID(),
      sales: "重点区域人员门禁管控",
      moduleId: "ACS",
      product: "A",
      version: "v1",
      excerpts: [{ lineStart: 10, lineEnd: 10, quote: "支持跨控制器反潜回" }],
    },
  ],
  searches: [{ subrequirementId: "T-1.1", query: "反潜回", traceId: 1 }],
});
test("批量计划不丢条款，控制每次模型请求数量与输入预算", () => {
  const packets = Array.from({ length: 12 }, (_, i) => ({
    ...packet(),
    requirement: { ...packet().requirement, id: `T-${i + 1}` },
  }));
  const batches = planQuickBatches(packets, 100000);
  assert.deepEqual(
    batches.map((b) => b.length),
    [5, 5, 2],
  );
  assert.equal(batches.flat().length, 12);
  assert.throws(() => planQuickBatches([packet()], 10), /预算/);
});
test("模型输出必须恰好覆盖当前批次，拒绝重复、遗漏或额外条款", () => {
  const item = {
    requirementId: "T-1",
    selections: [],
    checks: [
      {
        subrequirementId: "T-1.1",
        level: "unknown",
        reason: "缺少证据",
        direction: "待核实",
        delivery: "unknown",
        deliveryConfirmed: false,
        evidence: [],
      },
    ],
  };
  assert.equal(parseQuickJudgments({ assessments: [item] }, ["T-1"]).length, 1);
  assert.throws(
    () => parseQuickJudgments({ assessments: [item, item] }, ["T-1"]),
    /条款/,
  );
  assert.throws(() => parseQuickJudgments({ assessments: [] }, ["T-1"]));
  assert.throws(
    () => parseQuickJudgments({ assessments: [item] }, ["T-2"]),
    /条款/,
  );
});
test("候选与证据身份由后端绑定，不接受模型伪造销售项路径或未知候选", () => {
  const p = packet();
  const judgment = parseQuickJudgments(
    {
      assessments: [
        {
          requirementId: "T-1",
          selections: [
            { candidateIndex: 0, purpose: "purchase", reason: "覆盖原始条款" },
          ],
          checks: [
            {
              subrequirementId: "T-1.1",
              level: "exact",
              reason: "完整规格明确支持跨控制器反潜回",
              direction: "跨控制器反潜回",
              delivery: "native",
              deliveryConfirmed: true,
              evidence: [
                {
                  candidateIndex: 0,
                  lineStart: 10,
                  lineEnd: 10,
                  quote: "支持跨控制器反潜回",
                },
              ],
            },
          ],
        },
      ],
    },
    ["T-1"],
  )[0];
  const assessment = buildQuickAssessment(p, judgment, {
    name: "A",
    version: "v1",
    path: "wiki/entities/products/a.md",
  });
  assert.equal(assessment.level, "exact");
  assert.deepEqual(assessment.sales, [p.candidates[0].sales]);
  assert.equal(assessment.evidence[0].snapshotId, p.candidates[0].snapshotId);
  assert.equal(
    assessment.verification?.contributions[0].path,
    p.candidates[0].path,
  );
  assert.throws(
    () =>
      buildQuickAssessment(
        p,
        {
          ...judgment,
          selections: [
            { candidateIndex: 99, purpose: "purchase", reason: "不存在" },
          ],
        },
        { name: "A", version: "v1", path: "" },
      ),
    /候选/,
  );
});
