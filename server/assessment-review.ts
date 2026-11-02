import type { AssessmentInput } from "../shared/domain.js";

// Only straightforward, evidenced native matches may finish review inline.
export function reviewRisks(item: AssessmentInput, raw = "") {
  const risks = new Set<string>();
  const v = item.verification;
  if (!v?.checks.length) risks.add("缺少完整核验记录");
  if (item.level !== "exact") risks.add("存在缺口或不确定结论");
  const requirement = raw.replace(
    /^\s*(?:T-\d+\s*[:：、.]?|[（(]?\d+[)）.、]\s*)/,
    "",
  );
  if (/[0-9０-９≥≤<>]|不得|禁止|除非|仅限|前提|例外/.test(requirement))
    risks.add("数值、否定或条件约束");
  if (v?.checks.some((c) => c.quantitative)) risks.add("量化参数");
  if (v?.checks.some((c) => c.delivery !== "native" || !c.deliveryConfirmed))
    risks.add("交付方式待专项核实");
  if (v?.checks.some((c) => c.level !== "exact" || !c.evidence.length))
    risks.add("核验项存在缺口或缺少证据");
  if (
    v?.integrationRequired ||
    v?.integrations.length ||
    new Set(v?.contributions.map((c) => c.product)).size > 1
  )
    risks.add("跨产品或集成");
  if (
    v?.contributions.some((c) => c.purpose !== "purchase" || c.reuseOf) ||
    item.dependencies.length ||
    item.mustSelect.length
  )
    risks.add("依赖、复用或候选贡献");
  if (!item.evidence.length || !v?.contributions.length)
    risks.add("缺少实体证据或贡献项");
  return [...risks];
}

export function canReviewInline(item: AssessmentInput, raw: string) {
  return item.selfReview?.completed === true && !reviewRisks(item, raw).length;
}
