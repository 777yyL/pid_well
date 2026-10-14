interface ActivityInput {
  tool?: string;
  phase: string;
  waitingSeconds: number;
  disconnected?: boolean;
  stale?: boolean;
  queued?: boolean;
}
const actions: Record<string, [string, string]> = {
  project_context: [
    "先对齐一下项目情况",
    "看看已有成果和你的选择，接着往下做。",
  ],
  read_document: [
    "先翻翻原文，关键限定也要算数",
    "正在读取招标文件。长文分批看，读过的行数会显示在下方。",
  ],
  save_requirements: [
    "把需求理清楚，再往下走",
    "正在保存技术条款，原文和行号一起留下，方便你核对。",
  ],
  wiki_overview: [
    "看看产品家底，选型先有方向",
    "正在读取产品总览，比较哪些产品值得进一步核实。",
  ],
  recommend_products: [
    "给候选产品排个队",
    "正在整理推荐理由与选型方案，最终选谁由你决定。",
  ],
  recommend_product_plans: [
    "帮你搭一套有分工的方案",
    "正在比较现有候选，说明建议选哪些产品、各自负责什么。",
  ],
  wiki_product_catalog: [
    "先在选定产品里找找",
    "正在读取已选产品的销售项目录，先把检索范围划清楚。",
  ],
  wiki_search: [
    "需求找搭档，先从自家产品开始",
    "正在已选产品的销售项中检索，候选命中后还要核实原文。",
  ],
  wiki_read: [
    "证据要到位，不能只听产品名字",
    "正在读取知识库原文，核实能力、规格和版本。",
  ],
  wiki_global_search: [
    "范围内证据不足，再往外找找",
    "正在全局补查。其他产品的能力会单列建议，等你确认再纳入范围。",
  ],
  save_assessments: [
    "把判断落到纸面上",
    "正在保存匹配结论和依据，已保存的成果会同步到评估区。",
  ],
  review_assessments: [
    "再过一遍，看看有没有遗漏",
    "正在逐条复核规格、依赖和覆盖情况。已复核数量会显示在下方。",
  ],
  export_report: [
    "给成果收个尾",
    "正在生成报告或销售项清单，生成成功后会提供下载入口。",
  ],
};
export function activityCopy(input: ActivityInput) {
  if (input.disconnected || input.stale)
    return {
      tone: "warning" as const,
      title: input.disconnected
        ? "连接暂时中断，正在重新连接"
        : "状态更新延迟，暂时无法确认执行情况",
      description:
        "已保存的成果会保留。连接恢复后自动同步，请先不要重复发起任务。",
    };
  if (input.queued)
    return {
      tone: "normal" as const,
      title: "任务接到了，等执行名额空出来",
      description: "当前还在排队，轮到这项任务后会自动开始。",
    };
  const copy = input.tool
    ? actions[input.tool]
    : /压缩上下文/.test(input.phase)
      ? [
          "把笔记理一理，再接着往下走",
          "正在压缩对话上下文并保存检查点，整理后继续本次任务。",
        ]
      : /准备/.test(input.phase)
        ? [
            "任务接到了，先准备一下",
            "正在准备执行环境，稍后同步具体动作与进度。",
          ]
        : undefined;
  const [title, description] = copy ?? [
    input.tool ? "正在处理下一步动作" : "让模型想好下一步怎么走",
    input.tool
      ? "工具正在执行，返回结果后会更新状态。"
      : "正在等待模型回复或下一步工具调用，已有成果会继续保留。",
  ];
  return {
    tone: "normal" as const,
    title,
    description:
      input.waitingSeconds >= 60
        ? `${description} 这一步尚未返回结果，当前无法估算剩余时间。`
        : description,
  };
}
