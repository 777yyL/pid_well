import { z } from "zod";
import { verdict } from "./domain.js";

export const evaluationSchema = z.object({
  dataset: z.string().min(1),
  synthetic: z.boolean(),
  knowledgeVersion: z.string().min(1),
  modelConfiguration: z.string().min(1),
  cases: z
    .array(
      z.object({
        id: z.string().min(1),
        projectId: z.string().min(1),
        split: z.enum(["development", "holdout"]),
        expectedLevel: verdict.optional(),
        predictedLevel: verdict.optional(),
        expectedCandidates: z.array(z.string()).optional(),
        candidates: z.array(z.string()).optional(),
        expectedClauses: z.array(z.string()).optional(),
        extractedClauses: z.array(z.string()).optional(),
        expectedSales: z.array(z.string()).optional(),
        selectedSales: z.array(z.string()).optional(),
        humanCorrections: z.number().int().min(0).optional(),
        policyExpected: z.boolean().optional(),
        policyActual: z.boolean().optional(),
      }),
    )
    .min(1),
});
export type EvaluationInput = z.infer<typeof evaluationSchema>;
const fraction = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  rate: denominator ? numerator / denominator : null,
});
export function evaluateAccuracy(input: EvaluationInput) {
  const data = evaluationSchema.parse(input),
    cases = data.cases;
  if (new Set(cases.map((c) => c.id)).size !== cases.length)
    throw new Error("评测案例编号不能重复");
  const projects = new Map<string, string>();
  for (const c of cases) {
    if (projects.has(c.projectId) && projects.get(c.projectId) !== c.split)
      throw new Error("同一项目不得跨调试集和保留集");
    projects.set(c.projectId, c.split);
  }
  const labeled = cases.filter(
    (c) => c.expectedLevel !== undefined && c.predictedLevel !== undefined,
  );
  const predictedExact = labeled.filter((c) => c.predictedLevel === "exact");
  const unknown = labeled.filter((c) => c.expectedLevel === "unknown");
  const paired = (
    gold: "expectedCandidates" | "expectedClauses" | "expectedSales",
    predicted: "candidates" | "extractedClauses" | "selectedSales",
  ) => cases.filter((c) => c[gold] !== undefined && c[predicted] !== undefined);
  const candidateCases = paired("expectedCandidates", "candidates"),
    clauseCases = paired("expectedClauses", "extractedClauses"),
    salesCases = paired("expectedSales", "selectedSales");
  const count = (
    items: typeof cases,
    key:
      | "expectedCandidates"
      | "expectedClauses"
      | "expectedSales"
      | "selectedSales",
  ) => items.reduce((n, c) => n + new Set(c[key]).size, 0);
  const missing = (
    items: typeof cases,
    gold: "expectedClauses" | "expectedSales",
    predicted: "extractedClauses" | "selectedSales",
  ) =>
    items.reduce(
      (n, c) =>
        n +
        [...new Set(c[gold])].filter((id) => !c[predicted]!.includes(id))
          .length,
      0,
    );
  return {
    dataset: data.dataset,
    synthetic: data.synthetic,
    knowledgeVersion: data.knowledgeVersion,
    modelConfiguration: data.modelConfiguration,
    sampleCount: cases.length,
    projectCount: projects.size,
    warning: data.synthetic
      ? "合成回归仅验证程序策略，不代表公司真实业务准确率或模型语义判断准确率"
      : "标注与预测由调用方提供；请检查样本独立性和标注裁定",
    falseExactRate: fraction(
      predictedExact.filter((c) => c.expectedLevel !== "exact").length,
      predictedExact.length,
    ),
    candidateRecall: fraction(
      candidateCases.reduce(
        (n, c) =>
          n +
          [...new Set(c.expectedCandidates)].filter((id) =>
            c.candidates!.includes(id),
          ).length,
        0,
      ),
      count(candidateCases, "expectedCandidates"),
    ),
    clauseOmission: fraction(
      missing(clauseCases, "expectedClauses", "extractedClauses"),
      count(clauseCases, "expectedClauses"),
    ),
    salesOmission: fraction(
      missing(salesCases, "expectedSales", "selectedSales"),
      count(salesCases, "expectedSales"),
    ),
    salesWrongSelection: fraction(
      salesCases.reduce(
        (n, c) =>
          n +
          [...new Set(c.selectedSales)].filter(
            (id) => !c.expectedSales!.includes(id),
          ).length,
        0,
      ),
      count(salesCases, "selectedSales"),
    ),
    unknownRecognition: fraction(
      unknown.filter((c) => c.predictedLevel === "unknown").length,
      unknown.length,
    ),
    humanCorrections: {
      total: cases.reduce((n, c) => n + (c.humanCorrections ?? 0), 0),
      labeledCases: cases.filter((c) => c.humanCorrections !== undefined)
        .length,
    },
    policyChecks: fraction(
      cases.filter(
        (c) =>
          c.policyExpected !== undefined && c.policyActual === c.policyExpected,
      ).length,
      cases.filter(
        (c) => c.policyExpected !== undefined && c.policyActual !== undefined,
      ).length,
    ),
    uncovered: {
      verdicts: cases
        .filter((c) => !c.expectedLevel || !c.predictedLevel)
        .map((c) => c.id),
      candidates: cases
        .filter(
          (c) =>
            c.expectedCandidates === undefined || c.candidates === undefined,
        )
        .map((c) => c.id),
      clauses: cases
        .filter(
          (c) =>
            c.expectedClauses === undefined || c.extractedClauses === undefined,
        )
        .map((c) => c.id),
      sales: cases
        .filter(
          (c) => c.expectedSales === undefined || c.selectedSales === undefined,
        )
        .map((c) => c.id),
      humanCorrections: cases
        .filter((c) => c.humanCorrections === undefined)
        .map((c) => c.id),
    },
  };
}
