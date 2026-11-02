import type { AssessmentInput } from "../shared/domain.js";
import { selectedContributions } from "../shared/accuracy.js";

// Accept the common single-name array typo without guessing between multiple sales.
export function normalizeAssessmentInput(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  return input.map((item) => {
    const copy = structuredClone(item);
    if (Array.isArray(copy?.verification?.contributions)) {
      for (const contribution of copy.verification.contributions) {
        if (
          Array.isArray(contribution?.sales) &&
          contribution.sales.length === 1
        )
          contribution.sales = contribution.sales[0];
      }
    }
    return copy;
  });
}

export function normalizeAssessmentEvidence(
  item: AssessmentInput,
  snapshots: Map<string, string>,
) {
  const v = item.verification;
  const references = [
    ...item.evidence,
    ...(v?.checks.flatMap((c) => c.evidence) ?? []),
    ...(v?.contributions.flatMap((c) => c.evidence) ?? []),
    ...(v?.integrations.flatMap((c) => c.evidence) ?? []),
  ];
  for (const evidence of references) {
    const content = snapshots.get(evidence.snapshotId);
    if (!content || !evidence.quote.trim()) continue;
    const lines = content.split(/\r?\n/);
    const span = lines
      .slice(evidence.lineStart - 1, evidence.lineEnd)
      .join("\n");
    // Valid references, including multiline ranges, remain valid unchanged.
    if (
      evidence.lineStart <= evidence.lineEnd &&
      evidence.lineEnd <= lines.length &&
      span.includes(evidence.quote)
    )
      continue;
    const pattern = evidence.quote
      .trim()
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    const matches = [...content.matchAll(new RegExp(pattern, "g"))];
    if (matches.length !== 1) continue;
    const match = matches[0];
    const start = match.index!;
    evidence.quote = match[0];
    evidence.lineStart = content.slice(0, start).split(/\r?\n/).length;
    evidence.lineEnd = evidence.lineStart + match[0].split(/\r?\n/).length - 1;
  }
}

export function normalizeProcurementNames(item: AssessmentInput) {
  if (item.verification) {
    // Unrelated names are semantic errors, not formatting mistakes.
    const known = new Set(item.verification.contributions.map((c) => c.sales));
    if (item.sales.some((name) => !known.has(name))) return;
    item.sales = [...new Set(selectedContributions(item).map((c) => c.sales))];
  }
}
