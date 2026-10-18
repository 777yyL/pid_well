import { z } from "zod";

export const capabilityScopeSchema = z.object({
  product: z.string().trim().max(200).default(""),
  version: z.string().trim().max(100).default(""),
});
export const capabilityQuestionSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  focusPaths: z
    .array(z.string().regex(/^wiki\/entities\/(?:sale-items\/)?[^/\\]+\.md$/))
    .max(4)
    .default([]),
});
export const capabilityCreateSchema = capabilityQuestionSchema.extend({
  wikiProjectId: z.string().trim().min(1).max(500),
  sourceProjectId: z.string().uuid().optional(),
  scope: capabilityScopeSchema.default({ product: "", version: "" }),
  useProjectScope: z.boolean().default(true),
});
export const capabilityProofSchema = z.object({
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  quote: z.string().min(1).max(1500),
});
export const capabilityJudgmentSchema = z.object({
  results: z
    .array(
      z.object({
        path: z.string(),
        checks: z
          .array(
            z.object({
              requirement: z.string().min(1).max(500),
              status: z.enum([
                "supported",
                "partial",
                "unsupported",
                "unknown",
              ]),
              reason: z.string().min(1).max(1500),
              delivery: z.enum([
                "native",
                "configuration",
                "integration",
                "customization",
                "external",
                "unknown",
              ]),
              evidence: z.array(capabilityProofSchema).max(4),
            }),
          )
          .min(1)
          .max(8),
      }),
    )
    .max(8),
});
export type CapabilityCheck = z.infer<
  typeof capabilityJudgmentSchema
>["results"][number]["checks"][number];
export type CapabilityResult = {
  path: string;
  pageId: string;
  title: string;
  product: string;
  version: string;
  moduleId: string;
  description: string;
  unit: string;
  price?: number;
  quotation: string;
  dependencies: string[];
  productPath?: string;
  productName?: string;
  department?: string;
  owner?: string;
  status: "supported" | "partial" | "candidate" | "unsupported";
  membershipVerified: boolean;
  membershipNote: string;
  checks: CapabilityCheck[];
};
export type CapabilityTurn = {
  id: string;
  question: string;
  focusPaths: string[];
  status: "running" | "completed" | "failed" | "cancelled";
  phase: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  requirements: string[];
  queries: string[];
  results: CapabilityResult[];
  warnings: string[];
  searched: number;
};
export type CapabilityData = {
  scope: z.infer<typeof capabilityScopeSchema>;
  projectScope: { name: string; version: string; path: string }[];
  turns: CapabilityTurn[];
};
export type CapabilitySession = {
  id: string;
  title: string;
  wiki_project_id: string;
  source_project_id: string | null;
  status: string;
  data: CapabilityData;
  created_at: string;
  updated_at: string;
};

// An exact quote proves provenance, not natural-language entailment. Keep that distinction in the UI.
export function validCapabilityChecks(
  checks: CapabilityCheck[],
  content: string,
): CapabilityCheck[] {
  const lines = content.split(/\r?\n/);
  const front = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
  const frontLines = front?.[0].split(/\r?\n/).length ?? 0;
  return checks.map((check) => {
    const evidence = check.evidence.filter(
      (e) =>
        e.lineStart > frontLines &&
        e.lineEnd >= e.lineStart &&
        e.lineEnd <= lines.length &&
        lines
          .slice(e.lineStart - 1, e.lineEnd)
          .join("\n")
          .includes(e.quote) &&
        e.quote.split(/\r?\n/).some((s) => s.trim() && !/^\s*#/.test(s)),
    );
    const status = evidence.length ? check.status : "unknown";
    return {
      ...check,
      evidence,
      status,
      reason:
        check.evidence.length && !evidence.length
          ? "引用未通过原文核对，需重新核实。"
          : check.reason,
    };
  });
}
export function capabilityStatus(
  result: Pick<CapabilityResult, "checks" | "membershipVerified">,
  requirements: string[],
): CapabilityResult["status"] {
  const checks = result.checks;
  if (
    !result.membershipVerified ||
    checks.length !== requirements.length ||
    requirements.some((r) => !checks.some((c) => c.requirement === r))
  )
    return "candidate";
  if (
    checks.every(
      (c) =>
        c.status === "supported" &&
        c.evidence.length &&
        c.delivery === "native",
    )
  )
    return "supported";
  if (checks.every((c) => c.status === "unsupported" && c.evidence.length))
    return "unsupported";
  if (checks.some((c) => c.status === "supported" || c.status === "partial"))
    return "partial";
  return "candidate";
}
