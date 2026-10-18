import { test } from "node:test";
import assert from "node:assert/strict";
import { checkVerdict } from "../server/assessment.js";
import { assessmentSchema } from "../shared/domain.js";
import { aggregateVerdict, quantitativePass } from "../shared/accuracy.js";
import { collectSales } from "../server/sale-entity.js";
import { evaluateAccuracy } from "../shared/evaluation.js";
import { syntheticAccuracyCases } from "./fixtures/accuracy-cases.js";

const legacy = assessmentSchema.parse({
  requirementId: "T-1",
  product: "A",
  version: "v1",
  sales: [],
  level: "unknown",
  ok: [],
  no: [],
  hard: [],
  note: "文档未说明 MQTT，待确认",
  criteria: {
    direction: "待确认",
    scope: "待确认",
    spec: "待确认",
    context: "待确认",
    delivery: "待确认",
  },
  evidence: [],
  dependencies: [],
  mustSelect: [],
});
test("资料缺失允许待确认，明确不满足必须有反向证据", () => {
  assert.doesNotThrow(() => checkVerdict(legacy));
  assert.throws(
    () => checkVerdict({ ...legacy, level: "no_match", no: ["未找到 MQTT"] }),
    /证据/,
  );
});
test("固定合成策略集可重复运行；遗漏与未覆盖分母不能隐藏", () => {
  const result = evaluateAccuracy(syntheticAccuracyCases());
  assert.equal(result.sampleCount, 11);
  assert.equal(result.falseExactRate.numerator, 0);
  assert.equal(result.unknownRecognition.rate, 1);
  assert.equal(result.policyChecks.rate, 1);
  assert.deepEqual(result.clauseOmission, {
    numerator: 1,
    denominator: 2,
    rate: 0.5,
  });
  assert.ok(result.uncovered.humanCorrections.length);
  const bad = syntheticAccuracyCases();
  bad.cases = [
    {
      id: "bad",
      projectId: "p",
      split: "holdout",
      expectedLevel: "unknown",
      predictedLevel: "exact",
      expectedSales: ["A"],
      selectedSales: ["B"],
      humanCorrections: 2,
    },
  ];
  assert.equal(evaluateAccuracy(bad).falseExactRate.rate, 1);
  assert.equal(evaluateAccuracy(bad).salesOmission.rate, 1);
  assert.equal(evaluateAccuracy(bad).salesWrongSelection.rate, 1);
  assert.equal(evaluateAccuracy(bad).humanCorrections.total, 2);
  bad.cases.push({ ...bad.cases[0], id: "leak", split: "development" });
  assert.throws(() => evaluateAccuracy(bad), /跨/);
});
test("未选候选与未知结论不能进入正式销售清单", () => {
  assert.deepEqual(collectSales([{ ...legacy, sales: ["候选"] }], []), []);
});
test("精度误差按上限比较，单位未知保持未知", () => {
  const q = {
    operator: "<=" as const,
    requiredValue: 1,
    actualValue: 2,
    unit: "m",
    actualUnit: "m",
    condition: "定位误差",
    confirmed: true,
  };
  assert.equal(quantitativePass(q), false);
  assert.equal(
    quantitativePass({ ...q, actualUnit: "cm", actualValue: 30 }),
    true,
  );
  assert.equal(quantitativePass({ ...q, actualUnit: "pixel" }), null);
  assert.equal(
    aggregateVerdict(legacy, {
      id: "T-1",
      raw: "MQTT",
      documentId: "",
      module: "协议",
      type: "接口",
      lineStart: 1,
      lineEnd: 1,
    }),
    "unknown",
  );
});
