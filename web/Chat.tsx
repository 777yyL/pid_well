import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Tag, Steps, Dropdown, Tooltip } from "antd";
import {
  ArrowUpOutlined,
  PaperClipOutlined,
  StopOutlined,
  SyncOutlined,
  CheckOutlined,
  FileSearchOutlined,
  MoreOutlined,
} from "@ant-design/icons";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
  wiki_search: "检索产品知识",
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
}: {
  messages: ChatMessage[];
  events: RunEvent[];
  streaming: string;
  conversation?: Conversation;
  activeRun?: Run;
  latestRun?: Run;
  sending: boolean;
  onSend: (text: string) => Promise<void>;
  onCancel: () => void;
  onUpload: () => void;
  hasDocuments: boolean;
}) {
  const [draft, setDraft] = useState("");
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
  const compaction = events
    .filter((e) => e.type === "context_compaction")
    .at(-1);
  async function submit(text = draft) {
    if (!text.trim() || activeRun || sending) return;
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
      {compaction && (
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
            <h2>从一份清单，开始有据可查的评估。</h2>
            <p>
              上传招标文件，告诉 Agent
              你的目标。它会制定计划、阅读条款、检索销售项，并保留判断依据。
            </p>
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
                  {item.role === "user" ? "你" : "研"}
                </span>
                <b>{item.role === "user" ? "你" : "标研 Agent"}</b>
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
              <details key={event.id}>
                <summary>
                  <span>
                    {finish ? (
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
              <span className="message-avatar">研</span>
              <b>标研 Agent</b>
              <span className="muted">正在回复</span>
            </div>
            <div className="message-content">
              <Markdown text={streaming} />
            </div>
          </article>
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
          disabled={!!activeRun}
        />
        <div className="composer-bottom">
          <div>
            <Tooltip title="上传招标文件">
              <Button
                type="text"
                icon={<PaperClipOutlined />}
                onClick={onUpload}
                aria-label="上传招标文件"
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
              disabled={!draft.trim()}
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
