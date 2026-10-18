import type { AssessmentInput, RequirementInput } from "../../shared/domain.js";
import { aggregateVerdict } from "../../shared/accuracy.js";
import { collectSales } from "../../server/sale-entity.js";
import { retrievalTokens } from "../../shared/retrieval.js";
import type { EvaluationInput } from "../../shared/evaluation.js";

export function syntheticAccuracyCases(): EvaluationInput {
  const evidence = [
    {
      snapshotId: "00000000-0000-4000-8000-000000000001",
      lineStart: 1,
      lineEnd: 1,
      quote: "支持触发及播报",
    },
  ];
  const requirement: RequirementInput = {
    id: "T-1",
    documentId: "00000000-0000-4000-8000-000000000002",
    raw: "触发并播报",
    module: "联动",
    type: "功能",
    lineStart: 1,
    lineEnd: 1,
    subrequirements: [
      { id: "trigger", raw: "触发", required: true, lineStart: 1, lineEnd: 1 },
      { id: "play", raw: "播报", required: true, lineStart: 1, lineEnd: 1 },
    ],
  };
  const item: AssessmentInput = {
    requirementId: "T-1",
    product: "A",
    version: "v1",
    sales: ["广播"],
    level: "exact",
    ok: [],
    hard: [],
    no: [],
    note: "合成",
    criteria: {
      direction: "提供",
      scope: "两项",
      spec: "无",
      context: "校园",
      delivery: "原生",
    },
    evidence,
    dependencies: [],
    mustSelect: [],
    verification: {
      version: 2,
      checks: ["trigger", "play"].map((id) => ({
        subrequirementId: id,
        level: "exact",
        direction: "提供",
        reason: "原文明确",
        delivery: "native",
        deliveryConfirmed: true,
        evidence,
      })),
      contributions: [],
      integrationRequired: false,
      integrations: [],
      supplementalSearch: [],
      counterchecks: {
        direction: "已查",
        omissions: "已查",
        quantitative: "已查",
        external: "已查",
        integration: "已查",
      },
    },
  };
  const mutate = (fn: (copy: AssessmentInput) => void) => {
    const copy = structuredClone(item);
    fn(copy);
    return aggregateVerdict(copy, requirement);
  };
  const rejected = (fn: () => unknown) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  const page = (version: string, deps = "[]") => ({
    id: `page-${version}`,
    path: `wiki/entities/sale-items/a-${version}.md`,
    hash: version,
    content: `---\ntitle: 广播\nproduct: A\nversion: ${version}\nmodule_id: AUDIO\ndependencies: ${deps}\n---\n支持播报`,
  });
  const row = {
    product: "A",
    version: "v1",
    sales: ["广播"],
    requirementId: "T-1",
    evidence: [{ snapshotId: "page-v1" }],
  };
  const cases: EvaluationInput["cases"] = (
    [
      {
        id: "unknown-protocol",
        expectedLevel: "unknown",
        predictedLevel: mutate((c) => {
          c.verification!.checks[0].level = "unknown";
          c.verification!.checks[0].evidence = [];
        }),
      },
      {
        id: "opposite-direction",
        expectedLevel: "no_match",
        predictedLevel: mutate((c) => {
          c.verification!.checks.forEach((s) => (s.level = "no_match"));
        }),
      },
      {
        id: "composite-missing",
        expectedLevel: "partial",
        predictedLevel: mutate((c) => {
          c.verification!.checks[1].level = "no_match";
        }),
      },
      {
        id: "numeric-boundary",
        expectedLevel: "exact",
        predictedLevel: mutate((c) => {
          c.verification!.checks[0].quantitative = {
            operator: "<=",
            requiredValue: 1,
            actualValue: 1,
            unit: "m",
            actualUnit: "m",
            condition: "误差",
            confirmed: true,
          };
        }),
      },
      {
        id: "unknown-unit",
        expectedLevel: "unknown",
        predictedLevel: mutate((c) => {
          c.verification!.checks[0].quantitative = {
            operator: "<=",
            requiredValue: 1,
            actualValue: 30,
            unit: "m",
            actualUnit: "pixel",
            condition: "未知换算",
            confirmed: true,
          };
        }),
      },
      {
        id: "cross-product-interface",
        expectedLevel: "unknown",
        predictedLevel: mutate((c) => {
          c.verification!.integrationRequired = true;
        }),
      },
      {
        id: "same-name-version",
        policyExpected: true,
        policyActual: rejected(() =>
          collectSales(
            [{ ...row, evidence: [{ snapshotId: "page-v2" }] }],
            [page("v2")],
          ),
        ),
      },
      {
        id: "dependency-missing",
        policyExpected: true,
        policyActual: rejected(() =>
          collectSales([row], [page("v1", "[核心平台]")]),
        ),
      },
      {
        id: "candidate-excluded",
        expectedSales: [],
        selectedSales: collectSales([{ ...row, level: "unknown" }], []).map(
          (s) => s.entity.moduleId,
        ),
      },
      {
        id: "synonym-recall",
        expectedCandidates: ["云台控制"],
        candidates: retrievalTokens("PTZ").includes("云台控制")
          ? ["云台控制"]
          : [],
      },
      // Deliberately omitted source item proves the omission metric remains visible.
      {
        id: "source-omission",
        expectedClauses: ["原文1", "原文2"],
        extractedClauses: ["原文1"],
      },
    ] satisfies Omit<EvaluationInput["cases"][number], "projectId" | "split">[]
  ).map((c) => ({
    ...c,
    projectId: "synthetic-policy",
    split: "holdout" as const,
  }));
  return {
    dataset: "fixed-synthetic-policy-v1",
    synthetic: true,
    knowledgeVersion: "synthetic-v1",
    modelConfiguration: "offline-program-policy/no-model",
    cases,
  };
}
