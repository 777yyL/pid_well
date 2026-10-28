import type { AssessmentInput, RequirementInput } from "./domain.js";
export function coverageLabel(status: string) {
  return (
    (
      {
        unchecked: "待检查",
        pending: "部分待检查",
        ai_checked: "AI 已检查",
        human_checked: "人工已检查",
      } as Record<string, string>
    )[status] ?? "待检查"
  );
}
export function highRisk(item: AssessmentInput) {
  return (
    item.level !== "exact" ||
    !item.verification ||
    item.verification.integrationRequired ||
    item.verification.checks.some(
      (c) =>
        ["customization", "external", "unknown"].includes(c.delivery) ||
        !c.deliveryConfirmed,
    )
  );
}

export function assessmentEvidence(item: AssessmentInput) {
  const v = item.verification;
  const all = [
    ...item.evidence,
    ...(v?.checks.flatMap((c) => c.evidence) ?? []),
    ...(v?.contributions.flatMap((c) => c.evidence) ?? []),
    ...(v?.integrations.flatMap((c) => c.evidence) ?? []),
  ];
  return [
    ...new Map(
      all.map((e) => [
        JSON.stringify([e.snapshotId, e.lineStart, e.lineEnd, e.quote]),
        e,
      ]),
    ).values(),
  ];
}

export function quantitativePass(
  q: NonNullable<
    NonNullable<
      AssessmentInput["verification"]
    >["checks"][number]["quantitative"]
  >,
): boolean | null {
  if (!q.confirmed || q.actualValue === undefined || !q.actualUnit) return null;
  const units: Record<string, [string, number]> = {
    m: ["length", 1],
    cm: ["length", 0.01],
    mm: ["length", 0.001],
    km: ["length", 1000],
    米: ["length", 1],
    厘米: ["length", 0.01],
    毫米: ["length", 0.001],
    s: ["time", 1],
    ms: ["time", 0.001],
    us: ["time", 0.000001],
    秒: ["time", 1],
    毫秒: ["time", 0.001],
  };
  const expected = units[q.unit],
    actual = units[q.actualUnit];
  if (
    q.unit !== q.actualUnit &&
    (!expected || !actual || expected[0] !== actual[0])
  )
    return null;
  const a =
      q.actualValue * (q.unit === q.actualUnit ? 1 : actual[1] / expected[1]),
    r = q.requiredValue;
  return { ">=": a >= r, ">": a > r, "<=": a <= r, "<": a < r, "=": a === r }[
    q.operator
  ];
}

// Only structurally verified records can be aggregated. This does not prove semantic entailment.
export function aggregateVerdict(
  item: AssessmentInput,
  requirement: RequirementInput,
) {
  const v = item.verification;
  if (!v) return "unknown" as const;
  const required = v.checks.filter(
    (check) =>
      requirement.subrequirements?.find(
        (sub) => sub.id === check.subrequirementId,
      )?.required !== false,
  );
  if (!required.length) return "unknown" as const;
  const levels = required.map((c) => {
    const numeric = c.quantitative ? quantitativePass(c.quantitative) : true;
    if (numeric === false && c.evidence.length) return "no_match";
    if (numeric === null) return "unknown";
    if (
      c.level === "exact" &&
      (!c.evidence.length ||
        !c.deliveryConfirmed ||
        ["customization", "unknown"].includes(c.delivery))
    )
      return "unknown";
    if (c.level === "no_match" && !c.evidence.length) return "unknown";
    return c.level;
  });
  let integrationUnknown =
    v.integrationRequired &&
    (!v.integrations.length ||
      v.integrations.some((i) => !i.confirmed || !i.evidence.length));
  const used = v.contributions.filter(
    (c) => !["candidate", "optional"].includes(c.purpose),
  );
  const products = [...new Set(used.map((c) => c.product))];
  if (products.length > 1) {
    const connected = new Set(products.slice(0, 1));
    for (let round = 0; round < products.length; round++) {
      for (const edge of v.integrations.filter(
        (i) => i.confirmed && i.evidence.length,
      )) {
        const from = used.find((c) => c.id === edge.from)?.product;
        const to = used.find((c) => c.id === edge.to)?.product;
        if (from && to && (connected.has(from) || connected.has(to))) {
          connected.add(from);
          connected.add(to);
        }
      }
    }
    integrationUnknown ||=
      !v.integrationRequired || products.some((p) => !connected.has(p));
  }
  if (levels.every((l) => l === "exact") && !integrationUnknown)
    return "exact" as const;
  if (levels.every((l) => l === "no_match")) return "no_match" as const;
  if (levels.some((l) => l === "no_match" || l === "partial"))
    return "partial" as const;
  return "unknown" as const;
}

export function selectedContributions(item: AssessmentInput) {
  if (!item.verification || !["exact", "partial"].includes(item.level))
    return [];
  return item.verification.contributions.filter((c) =>
    ["purchase", "dependency"].includes(c.purpose),
  );
}

export function accuracySummary(item: AssessmentInput) {
  if (!item.verification) return "历史结果：未按新版逐子要求核验";
  const v = item.verification;
  const outcome = {
    exact: "完全满足",
    partial: "部分满足",
    no_match: "不满足",
    unknown: "待确认",
  };
  const delivery = {
    native: "原生功能",
    configuration: "配置实现",
    integration: "集成实现",
    customization: "需要定制",
    external: "依赖外部条件",
    unknown: "待确认",
  };
  const purpose = {
    purchase: "新增采购",
    dependency: "正式依赖",
    existing: "已有授权复用",
    optional: "可选增强",
    candidate: "仅比较候选",
  };
  return [
    ...v.checks.map(
      (c) =>
        `${c.subrequirementId}：${outcome[c.level]}；${c.reason}；方向 ${c.direction}；交付 ${delivery[c.delivery]}（${c.deliveryConfirmed ? "已核实" : "待确认"}）${c.quantitative ? `；参数 ${c.quantitative.operator} ${c.quantitative.requiredValue} ${c.quantitative.unit}，实际 ${c.quantitative.actualValue ?? "未知"} ${c.quantitative.actualUnit ?? ""}，条件 ${c.quantitative.condition}` : ""}\n${c.evidence.map((e) => `  ${e.snapshotId}:L${e.lineStart}-L${e.lineEnd} ${e.quote}`).join("\n")}`,
    ),
    ...v.contributions.map(
      (c) =>
        `${c.product} ${c.version} / ${c.sales} [${purpose[c.purpose]}]：${c.capability}；${c.reason}${c.reuseOf ? `；复用来源贡献项 ${c.reuseOf}` : ""}`,
    ),
    ...v.integrations.map(
      (i) =>
        `联动 ${i.from} → ${i.to}：${i.protocol}；${i.direction}；兼容 ${i.compatibility}；配置 ${i.configuration}；授权 ${i.authorization}；${i.confirmed ? "已核实" : "待确认"}`,
    ),
    `反证检查：${Object.values(v.counterchecks).join("；")}`,
    ...v.supplementalSearch.map(
      (s) =>
        `补查 ${s.subrequirementId}：${s.query}；${s.outcome}；轨迹 #${s.traceId}`,
    ),
  ].join("\n");
}
