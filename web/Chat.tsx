import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Tag, Steps, Dropdown, Tooltip } from "antd";
import {
  ArrowUpOutlined,
  PaperClipOutlined,
  StopOutlined,
  SyncOutlined,
  CheckOutlined,
  WarningOutlined,
  MoreOutlined,
} from "@ant-design/icons";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  assessmentStartPrompt,
  quickStageLabels,
  type EvaluationMode,
} from "./workflow-guide";

import { malformedToolText } from "../shared/agent-protocol";
import type {
  ChatMessage,
  Conversation,
  Run,
  RunEvent,
} from "../shared/domain";
const names: Record<string, string> = {
  project_context: "读取项目状态",
  update_plan: "更新执行计划",
  read_document: "阅读招标原文",
  save_requirements: "保存抽取条款",
  wiki_search: "在已选产品内检索销售项",
  wiki_product_catalog: "读取已选产品销售项目录",
  wiki_global_search: "证据不足，进行全局补查",
  record_product_alternative: "记录其他产品可满足的建议",
  wiki_overview: "读取产品总览",
  wiki_read: "核实知识库证据",
  wiki_graph: "查看产品关联",
  save_assessments: "保存匹配结果",
  get_assessments: "读取指定评估与版本",
  recommend_products: "推荐候选产品",
  recommend_product_plans: "生成推荐选型方案",
  review_assessments: "逐条复核",
  record_finding: "记录阶段分析",
  export_report: "生成正式报告",
};
export function Markdown({ text }: { text: string }) {
  if (malformedToolText(text))
    return (
      <p className="protocol-warning">
        模型返回了不兼容的工具调用文本。这段文字没有作为工具执行，请查看任务状态或恢复执行。
      </p>
    );
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        table: ({ children }) => (
          <div
            className="message-table"
            role="region"
            aria-label="消息表格"
            tabIndex={0}
          >
            <table>{children}</table>
          </div>
        ),
        a: (props) => (
          <a {...props} target="_blank" rel="noopener noreferrer" />
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
export function Chat({
  messages,
  events,
  streaming,
  conversation,
  activeRun,
  latestRun,
  sending,
  onSend,
  onCancel,
  onUpload,
  hasDocuments,
  scopeConfirmed = false,
  connectionError,
  archived = false,
}: {
  messages: ChatMessage[];
  events: RunEvent[];
  streaming: string;
  conversation?: Conversation;
  activeRun?: Run;
  latestRun?: Run;
  sending: boolean;
  archived?: boolean;
  onSend: (text: string, mode?: EvaluationMode) => Promise<void>;
  onCancel: () => void;
  onUpload: () => void;
  hasDocuments: boolean;
  scopeConfirmed?: boolean;
  connectionError?: string;
}) {
  const [draft, setDraft] = useState("");
  const [startMode, setStartMode] = useState<EvaluationMode>("quick");
  const [planExpanded, setPlanExpanded] = useState(false);
  useEffect(() => setPlanExpanded(false), [conversation?.id]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!activeRun) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeRun?.id]);
  const end = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    if (
      stick.current &&
      (messages.length > 0 || streaming || events.length > 0)
    )
      end.current?.scrollIntoView({ block: "end", behavior: "instant" });
  }, [messages.length, streaming, events.length]);
  const tools = events
    .filter((e) => e.type === "tool_execution_start")
    .map((e) => {
      const finish = events.find(
        (x) =>
          x.type === "tool_execution_end" &&
          x.payload.toolCallId === e.payload.toolCallId,
      );
      return { event: e, finish };
    });
  const activeTools = tools.slice(-4);
  const catalogProgress = events
    .filter((e) => e.type === "catalog_progress")
    .at(-1);
  const compaction = events
    .filter((e) => e.type === "context_compaction")
    .at(-1);
  const sameConversation =
    !activeRun || activeRun.conversation_id === conversation?.id;
  const progress = sameConversation
    ? events.filter((e) => e.type === "run_progress").at(-1)
    : undefined;
  const retry = sameConversation
    ? events.filter((e) => e.type === "run_retry").at(-1)
    : undefined;
  const quickProgress = sameConversation
    ? events.filter((e) => e.type === "quick_progress").at(-1)
    : undefined;
  const quickFailures = Array.isArray(quickProgress?.payload.failures)
    ? (quickProgress.payload.failures as {
        requirementIds: string[];
        stage: string;
        message: string;
        attempt: number;
        retryable: boolean;
        at: string;
      }[])
    : [];
  const heartbeatAge = progress
    ? Math.max(
        0,
        Math.floor((now - new Date(progress.created_at).getTime()) / 1000),
      )
    : 0;
  const elapsed = activeRun
    ? Math.max(
        0,
        Math.floor((now - new Date(activeRun.created_at).getTime()) / 1000),
      )
    : 0;
  const currentTool = tools.findLast((t) => !t.finish);
  const phase = quickProgress
    ? String(quickProgress.payload.message ?? "") ||
      quickStageLabels[String(quickProgress.payload.stage)] ||
      "正在执行快速初评"
    : currentTool
      ? (names[String(currentTool.event.payload.toolName)] ?? "执行工具")
      : String(progress?.payload.phase ?? "正在准备模型请求").replace(
          /执行工具：(\w+)/,
          (_, name: string) => names[name] ?? name,
        );
  const phaseTimestamp = quickProgress
    ? Number(
        quickProgress.payload.stageStartedAt ??
          new Date(quickProgress.created_at).getTime(),
      )
    : currentTool
      ? new Date(currentTool.event.created_at).getTime()
      : Number(progress?.payload.phaseSince ?? now);
  const phaseSeconds = Number.isFinite(phaseTimestamp)
    ? Math.max(0, Math.floor((now - phaseTimestamp) / 1000))
    : 0;
  async function submit(text = draft, mode: EvaluationMode = "agent") {
    if (!text.trim() || activeRun || sending || archived) return;
    try {
      await onSend(text, mode);
      setDraft("");
    } catch {
      /* Workspace reports send errors. */
    }
  }
  const activityMessages = events
    .reduce<{ id: number; text: string; at: string }[]>((items, event) => {
      const text =
        event.type === "quick_progress"
          ? String(event.payload.message ?? "")
          : event.type === "tool_execution_start"
            ? (names[String(event.payload.toolName)] ?? "")
            : event.type === "run_retry"
              ? String(event.payload.reason ?? "")
              : "";
      if (text && items.at(-1)?.text !== text)
        items.push({ id: event.id, text, at: event.created_at });
      return items;
    }, [])
    .filter((item) => item.text !== phase)
    .slice(-4);
  const plan = conversation?.plan ?? [];
  const currentStep =
    plan.find((s) => s.status === "running") ??
    plan.find((s) => s.status === "blocked") ??
    plan.find((s) => s.status === "pending");
  return (
    <section className="chat-pane">
      <header className="pane-header">
        <div>
          <span className="eyebrow">AGENT SESSION</span>
          <h2>{conversation?.title ?? "开始一次评估"}</h2>
        </div>
        <Tag bordered={false} color={activeRun ? "processing" : "default"}>
          {activeRun
            ? activeRun.status === "queued"
              ? "等待执行"
              : "正在执行"
            : "Pi Agent"}
        </Tag>
      </header>
      {activeRun && sameConversation && compaction && (
        <div className="plan-heading" role="status">
          <span>
            {compaction.payload.stage === "started"
              ? "正在压缩上下文并保存检查点…"
              : "上下文已压缩，任务自动继续"}
          </span>
        </div>
      )}
      {plan.length > 0 && (
        <div className="plan-bar">
          <button
            className="plan-toggle"
            aria-expanded={planExpanded}
            onClick={() => setPlanExpanded((v) => !v)}
          >
            <span>执行计划</span>
            <b>{currentStep?.title ?? "计划步骤已完成"}</b>
            <small>
              {plan.filter((s) => s.status === "done").length}/{plan.length}
            </small>
            <span>{planExpanded ? "收起" : "展开"}</span>
          </button>
          {planExpanded && (
            <Steps
              size="small"
              direction="vertical"
              items={plan.map((step) => ({
                title: step.title,
                status:
                  step.status === "done"
                    ? "finish"
                    : step.status === "running"
                      ? "process"
                      : step.status === "blocked"
                        ? "error"
                        : "wait",
              }))}
            />
          )}
        </div>
      )}
      <div
        className="chat-scroll"
        ref={scroll}
        onScroll={() => {
          if (scroll.current)
            stick.current =
              scroll.current.scrollHeight -
                scroll.current.scrollTop -
                scroll.current.clientHeight <
              100;
        }}
      >
        {messages.length === 0 ? (
          <div className="chat-welcome">
            <h2>评标AI</h2>
          </div>
        ) : (
          messages.map((item) => (
            <article className={`chat-message ${item.role}`} key={item.id}>
              <div className="message-meta">
                <span className={`message-avatar ${item.role}`}>
                  {item.role === "user" ? "你" : "AI"}
                </span>
                <b>{item.role === "user" ? "你" : "评标AI Agent"}</b>
                <time>
                  {new Date(item.created_at).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              <div className="message-content">
                {item.role === "user" ? (
                  <div className="user-text">{item.content}</div>
                ) : (
                  <Markdown text={item.content} />
                )}
              </div>
            </article>
          ))
        )}
        {activeTools.length > 0 && (
          <details className="tool-trail">
            <summary>工具执行记录（{tools.length}）</summary>
            {activeTools.map(({ event, finish }) => (
              <details
                key={event.id}
                className={finish?.payload.isError ? "tool-error" : ""}
              >
                <summary>
                  <span>
                    {finish?.payload.isError ? (
                      <WarningOutlined />
                    ) : finish ? (
                      <CheckOutlined />
                    ) : (
                      <SyncOutlined spin={!!activeRun} />
                    )}
                  </span>
                  <b>
                    {names[String(event.payload.toolName)] ??
                      String(event.payload.toolName)}
                  </b>
                  <small>
                    {finish
                      ? finish.payload.isError
                        ? "需调整"
                        : "已完成"
                      : activeRun
                        ? "执行中"
                        : "已中断"}
                  </small>
                </summary>
                <pre>{JSON.stringify(event.payload.args, null, 2)}</pre>
                {Boolean(finish?.payload.isError) && (
                  <pre>{JSON.stringify(finish?.payload.result, null, 2)}</pre>
                )}
              </details>
            ))}
          </details>
        )}
        {streaming && (
          <article className="chat-message assistant">
            <div className="message-meta">
              <span className="message-avatar">AI</span>
              <b>评标AI Agent</b>
              <span className="muted">正在回复</span>
            </div>
            <div className="message-content">
              <Markdown text={streaming} />
            </div>
          </article>
        )}
        {archived && (
          <Alert
            type="info"
            showIcon
            message="项目已归档"
            description="可查看历史对话和结果。需要继续评估时，请在项目管理中恢复项目。"
          />
        )}
        {activeRun && !sameConversation && (
          <div className="live-activity" role="status">
            此项目的另一个会话正在执行。请在左侧切换到该会话查看实时进度；本项目同时只能执行一个任务。
          </div>
        )}
        {quickFailures.length > 0 && (
          <details className="quick-failures">
            <summary>
              错误与重试记录（{quickFailures.length}） ·{" "}
              {quickFailures.at(-1)?.requirementIds.join("、")}：
              {quickFailures.at(-1)?.message.slice(0, 100)}
            </summary>
            {quickFailures.map((failure, index) => (
              <div key={index}>
                <b>
                  {failure.requirementIds.join("、")} · {failure.stage} · 第{" "}
                  {failure.attempt} 次
                </b>
                <p>{failure.message}</p>
                <small>
                  {failure.retryable
                    ? "已安排一次重试，是否成功以保存结果为准"
                    : "该次操作未完成，其他条款继续处理"}{" "}
                  · {new Date(failure.at).toLocaleTimeString("zh-CN")}
                </small>
              </div>
            ))}
          </details>
        )}
        {quickProgress && !activeRun && (
          <div className="task-stream-finished">
            {String(quickProgress.payload.message ?? "初评结果已保存")}
          </div>
        )}
        {activeRun && sameConversation && !streaming && (
          <div className="task-narration" aria-label="实际执行动态">
            {activityMessages.map((item) => (
              <div key={item.id}>
                <time>
                  {new Date(item.at).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
                <span>{item.text}</span>
              </div>
            ))}
          </div>
        )}
        {activeRun && sameConversation && (
          <div
            className={`task-stream ${connectionError || heartbeatAge > 20 ? "connection-warning" : ""}`}
            role="status"
            aria-live="polite"
          >
            <div className="activity-title">
              <SyncOutlined spin={!connectionError && heartbeatAge <= 20} />
              <b>
                {connectionError
                  ? "正在重新连接，连通后自动同步任务状态"
                  : activeRun.status === "queued"
                    ? retry?.payload.kind === "resume"
                      ? `连接暂时中断，${Math.max(0, Math.ceil((new Date(String(retry.payload.resumeAt)).getTime() - now) / 1000))} 秒后自动继续`
                      : "正在等待执行"
                    : phase}
              </b>
              <span>
                {Math.floor(elapsed / 60)}分{elapsed % 60}秒
              </span>
            </div>
            <details className="task-stream-details">
              <summary>进度与执行详情</summary>
              {Array.isArray(quickProgress?.payload.activeRetrievals) &&
                quickProgress.payload.activeRetrievals.length > 0 && (
                  <small>
                    并行检索：
                    {(
                      quickProgress.payload.activeRetrievals as {
                        requirementId: string;
                        startedAt: number;
                      }[]
                    )
                      .map(
                        (r) =>
                          `${r.requirementId}（${Math.max(0, Math.floor((now - r.startedAt) / 1000))}秒）`,
                      )
                      .join("、")}
                  </small>
                )}
              {currentTool?.event.payload.toolName === "wiki_product_catalog" &&
                catalogProgress && (
                  <p className="muted">
                    销售项目录已读 {String(catalogProgress.payload.loaded)} /{" "}
                    {String(catalogProgress.payload.total)} 页 ·{" "}
                    {String(catalogProgress.payload.path)}
                  </p>
                )}
              {quickProgress ? (
                <div className="activity-counts">
                  {[
                    ["已检索", quickProgress.payload.retrieved],
                    ["模型已判断", quickProgress.payload.judged],
                    ["已保存", quickProgress.payload.saved],
                    ["失败", quickProgress.payload.failed],
                  ].map(([label, count]) => (
                    <span key={String(label)}>
                      {String(label)} <b>{Number(count ?? 0)}</b>
                    </span>
                  ))}
                </div>
              ) : (
                progress && (
                  <div className="activity-counts">
                    <span className="activity-counter">
                      原文已读 <b>{Number(progress.payload.readLines ?? 0)}</b>{" "}
                      / {Number(progress.payload.totalLines ?? 0)} 行
                    </span>
                    <span className="activity-counter">
                      条款 <b>{Number(progress.payload.requirements)}</b> ·
                      已确认 <b>{Number(progress.payload.confirmed)}</b>
                    </span>
                    <span className="activity-counter">
                      评估 <b>{Number(progress.payload.assessments)}</b> ·
                      已复核 <b>{Number(progress.payload.reviewed)}</b>
                    </span>
                    <span className="activity-counter">
                      执行 <b>{Number(progress.payload.turns)}</b> 轮
                    </span>
                  </div>
                )
              )}
              {progress && (
                <small>
                  最近同步 {heartbeatAge} 秒前 · 当前动作耗时 {phaseSeconds}秒
                </small>
              )}
              {retry && (
                <div className="activity-retry">
                  <WarningOutlined /> 自动恢复 {Number(retry.payload.attempt)} /
                  {Number(retry.payload.maxAttempts ?? 2)}：
                  {String(retry.payload.reason)}
                </div>
              )}
            </details>
          </div>
        )}
        {latestRun?.error && !activeRun && (
          <Alert
            className="run-error"
            type={latestRun.status === "failed" ? "error" : "warning"}
            showIcon
            message={latestRun.error}
            action={
              !activeRun &&
              ["failed", "interrupted"].includes(latestRun.status) ? (
                <Button
                  size="small"
                  onClick={() =>
                    void submit(
                      "请从已保存的项目结果和当前计划继续执行上一项任务。先读取项目状态，保留人工确认结果，避免重复创建条款。",
                      latestRun.evaluation_mode ?? "agent",
                    )
                  }
                >
                  恢复执行
                </Button>
              ) : undefined
            }
          />
        )}
        {!activeRun && latestRun?.status === "completed" && (
          <div className="turn-finished" role="status">
            <CheckOutlined /> 这一轮先交卷，成果已保存
            {plan.some((step) => step.status !== "done")
              ? "，项目计划尚未全部完成。请根据 Agent 的说明确认条款、产品选型或继续对话。"
              : "。结果与执行记录已保存，可继续追问。"}
          </div>
        )}
        <div ref={end} />
      </div>
      <div className="composer">
        <Input.TextArea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoSize={{ minRows: 2, maxRows: 7 }}
          maxLength={20000}
          placeholder="输入消息…"
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void submit();
            }
          }}
          disabled={!!activeRun || archived}
        />
        <div className="composer-bottom">
          <div>
            <Tooltip title="上传招标文件">
              <Button
                type="text"
                icon={<PaperClipOutlined />}
                onClick={onUpload}
                data-guide="upload"
                aria-label="上传招标文件"
                disabled={archived}
              />
            </Tooltip>
            <Tooltip
              title={
                hasDocuments
                  ? "阅读已解析文件，抽取条款并开始评估"
                  : "请先上传并解析招标文件"
              }
            >
              <Dropdown.Button
                data-guide={scopeConfirmed ? "continue" : "start"}
                type="primary"
                size="small"
                disabled={!hasDocuments || !!activeRun || sending || archived}
                loading={sending}
                menu={{
                  selectable: true,
                  selectedKeys: [startMode],
                  items: [
                    { key: "quick", label: "快速初评 · 批量匹配原清单" },
                    { key: "agent", label: "Agent 深度评估 · 自主规划" },
                  ],
                  onClick: ({ key }) => setStartMode(key as EvaluationMode),
                }}
                onClick={() =>
                  void submit(
                    scopeConfirmed
                      ? "产品范围已确认，请读取项目状态，按已选产品版本继续匹配和评估。"
                      : assessmentStartPrompt(startMode),
                    startMode,
                  )
                }
              >
                {startMode === "quick" ? "开始快速初评" : "开始深度评估"}
              </Dropdown.Button>
            </Tooltip>
            <span>Enter 发送 · Shift + Enter 换行</span>
          </div>
          {activeRun ? (
            <Button icon={<StopOutlined />} onClick={onCancel}>
              停止执行
            </Button>
          ) : (
            <Button
              type="primary"
              shape="circle"
              icon={<ArrowUpOutlined />}
              loading={sending}
              disabled={!draft.trim() || archived}
              aria-label="发送消息"
              onClick={() => void submit()}
            />
          )}
        </div>
      </div>
      <footer className="chat-footnote">
        AI 结论需结合原文与产品证据复核。人工确认结果将保留。
      </footer>
    </section>
  );
}
