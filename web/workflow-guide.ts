export const startAssessmentPrompt =
  "请先通过 project_context 列出本项目全部文件及解析状态，再评估所有已解析的招标文件；未解析或失败文件须明确列出，不能默认为已评估。一个文件对应一个子系统，默认以去掉扩展名的文件名区分子系统，并在条款模块中保留子系统归属。逐文件完整阅读原文，分别保存真实 documentId 和该文件行号，提取要求及评分办法。条款使用项目内连续且唯一的 T-编号，先核对已有条款再续号，禁止不同文件重复编号或覆盖已有条款；最后统一进行产品选型、匹配与报告汇总，并制定执行计划。";

export type EvaluationMode = "quick" | "agent";
export function assessmentStartPrompt(mode: EvaluationMode) {
  return mode === "quick"
    ? `${startAssessmentPrompt} 本次采用快速初评：保留原清单行作为评估单位，不强制拆成原子条款，不另行要求用户确认条款；保存原清单条款后直接推荐产品方案，等待用户在界面确认产品范围。此阶段不要执行销售项匹配；用户确认范围并点击继续初评后才开始批量评估。`
    : startAssessmentPrompt;
}

export const quickStageLabels: Record<string, string> = {
  retrieving: "正在批量检索候选销售项",
  judging: "正在核对需求与产品证据",
  saving: "正在保存初评结果",
  completed: "快速初评已完成",
  failed: "快速初评部分未完成",
};

export type GuidePhase =
  | "upload"
  | "start"
  | "requirements"
  | "products"
  | "selection"
  | "continue"
  | "review"
  | "export";
export function guidePhase(state: {
  documents: { status: string }[];
  requirements: { confirmed: boolean }[];
  assessments: { reviewed: boolean }[];
  scopeStatus: string;
  complete: boolean;
  hasRecommendations?: boolean;
  active: boolean;
  archived: boolean;
}): GuidePhase | null {
  if (state.active || state.archived) return null;
  if (state.complete) return "export";
  if (state.requirements.some((r) => !r.confirmed)) return "requirements";
  if (state.assessments.length) return "review";
  if (state.scopeStatus === "confirmed") return "continue";
  if (state.requirements.length)
    return state.hasRecommendations ? "selection" : "products";
  if (
    state.documents.some((d) =>
      ["pending", "processing", "parsing"].includes(d.status),
    )
  )
    return null;
  return state.documents.some((d) => d.status === "ready") ? "start" : "upload";
}
