import { useEffect, useState } from "react";
import { Alert, Button, Drawer, Empty, Select, Space, Switch, Tag } from "antd";
import { api } from "./api";

type Event = {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
};
type Run = { id: string; status: string; created_at: string };
const labels: Record<string, string> = {
  model_request: "模型输入",
  model_response: "模型输出",
  assistant_end: "对话回复",
  tool_execution_start: "工具调用",
  tool_execution_end: "工具返回",
  run_retry: "执行重试",
  run_finished: "执行结束",
  context_compaction: "上下文压缩",
  quick_progress: "初评进度",
};
const failed = (e: Event) =>
  Boolean(
    e.payload.isError ||
    e.payload.error ||
    ["error", "aborted"].includes(
      String(
        (e.payload.response as Record<string, unknown> | undefined)?.stopReason,
      ),
    ),
  );

export function AgentObservation({
  projectId,
  runs,
}: {
  projectId: string;
  runs: Run[];
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [events, setEvents] = useState<Event[]>([]);
  const [error, setError] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [kind, setKind] = useState("all");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  useEffect(() => {
    setSelected("");
    setEvents([]);
  }, [projectId]);
  useEffect(() => {
    if (!open || !selected) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const collected = new Map<number, Event>();
    setEvents([]);
    setError("");
    setLoading(true);
    async function poll() {
      try {
        let after = Math.max(0, ...collected.keys());
        let page;
        do {
          page = await api<{ run: Run; events: Event[] }>(
            `/runs/${selected}/observation?after=${after}`,
          );
          if (cancelled) return;
          for (const event of page.events) collected.set(event.id, event);
          after = Math.max(after, ...page.events.map((e) => Number(e.id)));
          setEvents([...collected.values()]);
          setStatus(page.run.status);
        } while (page.events.length === 100);
        setError("");
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(() => void poll(), 4000);
        }
      }
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, selected]);
  const visible = events.filter(
    (e) =>
      (!errorsOnly || failed(e)) &&
      (kind === "all" ||
        (kind === "model"
          ? e.type.startsWith("model_") || e.type === "assistant_end"
          : e.type.startsWith("tool_"))),
  );
  const responses = events.filter((e) => e.type === "model_response");
  const tokens = responses.reduce((sum, e) => {
    const usage = (
      e.payload.response as
        { usage?: { input?: number; output?: number } } | undefined
    )?.usage;
    return sum + (usage?.input || 0) + (usage?.output || 0);
  }, 0);
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ runId: selected, status, events }, null, 2)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `agent-${selected}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      <Button
        onClick={() => {
          setSelected(selected || runs[0]?.id || "");
          setOpen(true);
        }}
      >
        Agent 观测
      </Button>
      <Drawer
        title="Agent 观测"
        open={open}
        onClose={() => setOpen(false)}
        width="min(960px, 96vw)"
      >
        <Space wrap style={{ marginBottom: 20 }}>
          <Select
            style={{ width: 310 }}
            value={selected || undefined}
            placeholder="选择执行任务"
            onChange={setSelected}
            options={runs.map((r) => ({
              value: r.id,
              label: `${new Date(r.created_at).toLocaleString("zh-CN")} · ${r.status}`,
            }))}
          />
          <Select
            value={kind}
            onChange={setKind}
            options={[
              { value: "all", label: "全部记录" },
              { value: "model", label: "模型" },
              { value: "tool", label: "工具" },
            ]}
          />
          <Switch
            checked={errorsOnly}
            onChange={setErrorsOnly}
            checkedChildren="仅失败"
            unCheckedChildren="仅失败"
          />
          <Button
            disabled={loading || !events.length || Boolean(error)}
            onClick={download}
          >
            导出 JSON
          </Button>
        </Space>
        {error && <Alert type="error" showIcon message={error} />}
        <p style={{ color: "#64748b" }}>
          {loading
            ? "正在加载记录…"
            : `${status} · ${events.length} 条记录，每 4 秒同步`}{" "}
          · 历史任务仅展示已有记录
        </p>
        <Space wrap style={{ marginBottom: 16 }}>
          <Tag>
            模型调用 {events.filter((e) => e.type === "model_request").length}
          </Tag>
          <Tag>
            工具调用{" "}
            {events.filter((e) => e.type === "tool_execution_start").length}
          </Tag>
          <Tag color={events.some(failed) ? "error" : "default"}>
            失败记录 {events.filter(failed).length}
          </Tag>
          <Tag>输入 + 输出 Token {tokens.toLocaleString()}</Tag>
        </Space>
        {!visible.length && <Empty description="暂无符合条件的记录" />}
        {visible.map((e) => (
          <details
            key={e.id}
            style={{ borderBottom: "1px solid #e2e8f0", padding: "14px 0" }}
          >
            <summary style={{ cursor: "pointer" }}>
              <Tag
                color={
                  failed(e)
                    ? "error"
                    : e.type.startsWith("model_")
                      ? "blue"
                      : "default"
                }
              >
                {labels[e.type] || e.type}
              </Tag>
              {String(e.payload.toolName || "")}{" "}
              {e.payload.elapsedMs !== undefined &&
                `${(Number(e.payload.elapsedMs) / 1000).toFixed(1)}s`}
              <small style={{ float: "right", color: "#64748b" }}>
                {new Date(e.created_at).toLocaleTimeString("zh-CN")}
              </small>
            </summary>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                maxHeight: 520,
                overflow: "auto",
                background: "#f8fafc",
                padding: 16,
                fontSize: 13,
              }}
            >
              {JSON.stringify(e.payload, null, 2)}
            </pre>
          </details>
        ))}
      </Drawer>
    </>
  );
}
