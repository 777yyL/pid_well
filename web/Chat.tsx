import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Tag, Steps, Dropdown, Tooltip } from "antd";
import {
  ArrowUpOutlined,
  PaperClipOutlined,
  StopOutlined,
  SyncOutlined,
  CheckOutlined,
  WarningOutlined,
  FileSearchOutlined,
  MoreOutlined,
} from "@ant-design/icons";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
  onSend: (text: string) => Promise<void>;
  onCancel: () => void;
  onUpload: () => void;
  hasDocuments: boolean;
  connectionError?: string;
}) {
  const [draft, setDraft] = useState("");
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
  const phase = currentTool
    ? (names[String(currentTool.event.payload.toolName)] ?? "执行工具")
    : String(progress?.payload.phase ?? "正在准备模型请求").replace(
        /执行工具：(\w+)/,
        (_, name: string) => names[name] ?? name,
      );
  async function submit(text = draft) {
    if (!text.trim() || activeRun || sending || archived) return;
    try {
      await onSend(text);
      setDraft("");
    } catch {
      /* Notification is handled by workspace hook. */
    }
  }
  const plan = conversation?.plan ?? [];
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
          <div className="plan-heading">
            <span>执行计划</span>
            <span>
              {plan.filter((s) => s.status === "done").length} / {plan.length}
            </span>
          </div>
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
            <span className="welcome-icon">
              <FileSearchOutlined />
            </span>
            <h2>开始项目评估</h2>
            <p>
              上传一份招标清单，Agent
              会提取条款并检索产品证据。关键判断由你确认。
            </p>
            {!hasDocuments && (
              <ol className="empty-project-guide">
                <li>
                  <b>上传文件</b>
                  <span>提供招标清单或技术需求</span>
                </li>
                <li>
                  <b>AI 评估</b>
                  <span>提取条款，制定检索计划</span>
                </li>
                <li>
                  <b>确认与选型</b>
                  <span>核对原文，选择产品范围</span>
                </li>
                <li>
                  <b>复核与分享</b>
                  <span>确认结论，交付报告与清单</span>
                </li>
              </ol>
            )}
            <div className="suggestions">
              <button
                onClick={() =>
                  hasDocuments
                    ? void submit(
                        "请评估本项目上传的招标文件，先完整阅读原文，提取要求和评分办法，并制定执行计划。",
                      )
                    : onUpload()
                }
              >
                <b>评估招标清单</b>
                <span>解析、抽取、匹配与复核</span>
              </button>
              <button
                onClick={() =>
                  setDraft(
                    "请结合本项目的业务背景，从产品知识库分析适合的产品与版本，并列出选择依据。",
                  )
                }
              >
                <b>讨论产品方案</b>
                <span>围绕场景检索产品与版本</span>
              </button>
              <button
                onClick={() =>
                  setDraft(
                    "请复核已有评估中的部分满足和不满足项，检查能力方向、硬指标、依赖和缺失的销售项。",
                  )
                }
              >
                <b>核查评估风险</b>
                <span>追问缺口、证据与交付约束</span>
              </button>
            </div>
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
                <Markdown text={item.content} />
              </div>
            </article>
          ))
        )}
        {activeTools.length > 0 && (
          <div className="tool-trail">
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
          </div>
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
        {activeRun && sameConversation && (
          <div
            className={`live-activity ${connectionError || heartbeatAge > 20 ? "connection-warning" : ""}`}
            role="status"
            aria-live="polite"
          >
            <div className="activity-title">
              <SyncOutlined spin={!connectionError && heartbeatAge <= 20} />
              <b>
                {connectionError
                  ? "连接暂时中断，正在重新连接"
                  : heartbeatAge > 20
                    ? "执行状态更新延迟，正在核实"
                    : activeRun.status === "queued"
                      ? "任务排队中"
                      : phase}
              </b>
              <span>
                {Math.floor(elapsed / 60)}分{elapsed % 60}秒
              </span>
            </div>
            <p>
              {connectionError || heartbeatAge > 20
                ? "页面暂时无法确认服务端状态。已保存的结果会保留，连接恢复后自动同步，请避免重复发起任务。"
                : activeRun.status === "queued"
                  ? "等待可用的执行名额，排队结束后自动开始。"
                  : "任务仍在执行；下方为已保存的真实进度。模型等待期间也会持续同步状态。"}
            </p>
            {currentTool?.event.payload.toolName === "wiki_product_catalog" &&
              catalogProgress && (
                <p className="muted">
                  销售项目录已读 {String(catalogProgress.payload.loaded)} /{" "}
                  {String(catalogProgress.payload.total)} 页 ·{" "}
                  {String(catalogProgress.payload.path)}
                </p>
              )}
            {progress && (
              <div className="activity-counts">
                <span>
                  原文已读 <b>{Number(progress.payload.readLines ?? 0)}</b> /{" "}
                  {Number(progress.payload.totalLines ?? 0)} 行
                </span>
                <span>
                  条款 <b>{Number(progress.payload.requirements)}</b> · 已确认{" "}
                  <b>{Number(progress.payload.confirmed)}</b>
                </span>
                <span>
                  评估 <b>{Number(progress.payload.assessments)}</b> · 已复核{" "}
                  <b>{Number(progress.payload.reviewed)}</b>
                </span>
                <span>
                  执行 <b>{Number(progress.payload.turns)}</b> 轮
                </span>
              </div>
            )}
            {progress && (
              <small>
                最近同步 {heartbeatAge} 秒前 · 当前动作耗时{" "}
                {Math.max(
                  0,
                  Math.floor(
                    (now - Number(progress.payload.phaseSince)) / 1000,
                  ),
                )}{" "}
                秒
              </small>
            )}
            {retry && (
              <div className="activity-retry">
                <WarningOutlined /> 自动恢复 {Number(retry.payload.attempt)} /
                2：{String(retry.payload.reason)}
              </div>
            )}
          </div>
        )}
        {latestRun?.error && (
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
            <CheckOutlined /> 本轮执行已结束
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
          placeholder="提出目标、追问证据，或补充产品与版本约束…"
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
                aria-label="上传招标文件"
                disabled={archived}
              />
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
