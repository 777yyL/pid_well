import { useEffect, useRef, useState } from "react";
import { Button, Dropdown, Tour, type TourProps } from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";
import { type GuidePhase } from "./workflow-guide";

type Step = {
  title: string;
  description: string;
  target: string;
  tab?: string;
};
const guides: Record<GuidePhase, Step[]> = {
  upload: [
    {
      title: "第一步：上传招标文件",
      description:
        "点击这里选择文件。支持 DOCX、XLSX、PDF、Markdown 和 TXT，可一次上传多个子系统文件。扫描 PDF 请先完成 OCR。上传后等待解析完成，文件名用于区分子系统。",
      target: "upload",
    },
  ],
  start: [
    {
      title: "文件已准备好，点击开始评标",
      description:
        "上传不会自动启动评估。点击“开始评标”，Agent 才会阅读文件、提取条款并制定计划。执行中可在对话中查看进度；解析失败的文件应先处理或明确排除。",
      target: "start",
    },
  ],
  requirements: [
    {
      title: "核对抽取的条款",
      description:
        "点开条款对照文件原文，检查子系统、数量、参数及遗漏。发现问题可在对话中要求 Agent 修正。",
      target: "requirements",
      tab: "requirements",
    },
    {
      title: "确认后才能继续",
      description:
        "核对无误后点击“确认全部条款”；也可以勾选部分条款逐批确认。确认不代表产品已满足要求。",
      target: "confirm-requirements",
      tab: "requirements",
    },
  ],
  products: [
    {
      title: "生成产品选型建议",
      description:
        "点击“生成产品推荐”，让 Agent 根据需求比较产品。这里选择的是产品及版本，具体销售项会在后续评估中核实。",
      target: "recommend-products",
      tab: "products",
    },
  ],
  selection: [
    {
      title: "选方案，也可以逐个选产品",
      description:
        "有推荐方案时可一键选中组成。点击产品卡片查看详情，按分类浏览销售项；也可自定义产品。推荐不等于已经选用，互为替代的产品无需全选。",
      target: "product-options",
      tab: "products",
    },
    {
      title: "确认你的产品范围",
      description:
        "填写售前策略并点击“确认产品范围”。后续优先匹配所选产品，其他产品仅作为补充建议，不会自动加入正式范围。",
      target: "confirm-products",
      tab: "products",
    },
  ],
  continue: [
    {
      title: "范围已确认，继续匹配",
      description:
        "在对话框下方点击“开始快速初评”或选择深度评估，Agent 才会按照确认的产品及版本匹配销售项、核实证据。确认范围本身不会自动启动下一轮任务。",
      target: "continue",
      tab: "products",
    },
  ],
  review: [
    {
      title: "查看匹配结果与证据",
      description:
        "点开结果检查满足程度、缺口、参数、依赖及证据，再完成复核。结果未齐时，在对话中要求 Agent 继续；待确认不等于不满足。",
      target: "results",
      tab: "results",
    },
    {
      title: "完成后交付报告",
      description:
        "全部条款确认、匹配并复核后，才能导出正式报告和销售清单。按钮不可用时，先检查未完成条款和复核状态。",
      target: "export",
      tab: "results",
    },
  ],
  export: [
    {
      title: "导出评估报告和销售清单",
      description:
        "从导出菜单选择完整报告或 SPS 销售项清单。下载后核对交付范围及授权、数量等商务信息。",
      target: "export",
      tab: "results",
    },
    {
      title: "分享成果给同事",
      description:
        "创建成果链接后，同事无需登录即可查看分享结果并下载报告。分享固定的是当次成果，后续修改不会自动更新旧链接。",
      target: "share",
      tab: "results",
    },
  ],
};
const titles: Record<GuidePhase, string> = {
  upload: "文件上传",
  start: "开始评标",
  requirements: "核对技术条款",
  products: "生成产品推荐",
  selection: "产品与产品选型",
  continue: "继续销售项匹配",
  review: "结果与复核",
  export: "导出与分享",
};

export function WorkspaceGuide({
  userId,
  projectId,
  phase,
  enabled,
  navigate,
}: {
  userId: string;
  projectId: string;
  phase: GuidePhase | null;
  enabled: boolean;
  navigate: (tab?: string) => void;
}) {
  const [session, setSession] = useState<{
    steps: Step[];
  } | null>(null);
  const [current, setCurrent] = useState(0);
  const navigation = useRef(navigate);
  navigation.current = navigate;
  const key = (p: GuidePhase) => `workspace.guide.v1.${userId}.${p}`;
  function mark(p: GuidePhase) {
    try {
      localStorage.setItem(key(p), "seen");
    } catch {
      /* In-memory behavior still works when browser storage is unavailable. */
    }
  }
  function open(p: GuidePhase | "all") {
    const steps = p === "all" ? Object.values(guides).flat() : guides[p];
    setCurrent(0);
    navigation.current(steps[0].tab);
    setSession({ steps });
    if (p !== "all") mark(p);
  }
  useEffect(() => {
    setSession(null);
    if (!enabled || !phase) return;
    try {
      if (localStorage.getItem(key(phase))) return;
    } catch {
      return;
    }
    const timer = setTimeout(() => open(phase), 900);
    return () => clearTimeout(timer);
  }, [enabled, phase, projectId, userId]);
  const steps: TourProps["steps"] = session?.steps.map((step, i) => ({
    title: step.title,
    description: step.description,
    style: { maxWidth: "calc(100vw - 24px)" },
    target: (() => {
      const target = document.querySelector<HTMLElement>(
        `[data-guide="${step.target}"]`,
      );
      return target?.getClientRects().length ? target : null;
    }) as NonNullable<TourProps["steps"]>[number]["target"],
    nextButtonProps: {
      children: i === session.steps.length - 1 ? "知道了，去操作" : "下一步",
    },
    prevButtonProps: { children: "上一步" },
  }));
  return (
    <>
      <Dropdown
        trigger={["click"]}
        menu={{
          items: [
            { key: "current", label: "查看当前步骤", disabled: !phase },
            { key: "all", label: "查看完整操作流程" },
            { type: "divider" },
            ...Object.entries(titles).map(([key, label]) => ({ key, label })),
          ],
          onClick: ({ key: value }) => {
            if (value === "current") {
              if (phase) open(phase);
            } else open(value as GuidePhase | "all");
          },
        }}
      >
        <Button
          className="workspace-guide-entry"
          size="small"
          icon={<QuestionCircleOutlined />}
          disabled={!enabled}
        >
          操作引导
        </Button>
      </Dropdown>
      <Tour
        open={!!session && enabled}
        current={current}
        steps={steps}
        disabledInteraction
        onChange={(index) => {
          navigation.current(session?.steps[index]?.tab);
          setCurrent(index);
        }}
        actionsRender={(actions) => (
          <>
            <Button type="text" size="small" onClick={() => setSession(null)}>
              暂时跳过
            </Button>
            {actions}
          </>
        )}
        onClose={() => setSession(null)}
        onFinish={() => setSession(null)}
        scrollIntoViewOptions={{ block: "center", inline: "nearest" }}
      />
    </>
  );
}
