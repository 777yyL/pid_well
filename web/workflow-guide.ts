export const startAssessmentPrompt =
  "请先通过 project_context 列出本项目全部文件及解析状态，再评估所有已解析的招标文件；未解析或失败文件须明确列出，不能默认为已评估。一个文件对应一个子系统，默认以去掉扩展名的文件名区分子系统，并在条款模块中保留子系统归属。逐文件完整阅读原文，分别保存真实 documentId 和该文件行号，提取要求及评分办法。条款使用项目内连续且唯一的 T-编号，先核对已有条款再续号，禁止不同文件重复编号或覆盖已有条款；最后统一进行产品选型、匹配与报告汇总，并制定执行计划。";

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
