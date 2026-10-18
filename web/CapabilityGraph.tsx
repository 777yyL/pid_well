import { useEffect, useId, useState } from "react";
import { Alert, Button, Empty, Skeleton, Tag } from "antd";
import { api } from "./api";
import { KnowledgeMarkdown } from "./KnowledgeReader";
import type {
  CapabilityGraph as Graph,
  CapabilityGraphNode,
} from "../shared/capability-graph";

const relations = {
  product: "所属产品",
  dependency: "依赖 · 条件见原文",
  related: "普通关联",
};
export function CapabilityGraph({
  sessionId,
  pageId,
}: {
  sessionId: string;
  pageId: string;
}) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<CapabilityGraphNode | null>(null);
  const [page, setPage] = useState<{ content: string; hash: string } | null>(
    null,
  );
  const [pageError, setPageError] = useState("");
  const marker = useId().replace(/:/g, "");
  const base = `/capability/sessions/${sessionId}/pages/${pageId}`;
  useEffect(() => {
    const controller = new AbortController();
    setGraph(null);
    setError("");
    setSelected(null);
    void api<Graph>(`${base}/graph`, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setGraph(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [base, attempt]);
  useEffect(() => {
    setPage(null);
    setPageError("");
    if (!selected?.path) return;
    const controller = new AbortController();
    void api<{ content: string; hash: string }>(
      `${base}/related?path=${encodeURIComponent(selected.path)}`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (!controller.signal.aborted) setPage(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setPageError(e.message);
      });
    return () => controller.abort();
  }, [base, selected]);
  const height = Math.max(180, (graph?.nodes.length || 0) * 88);
  return (
    <section className="capability-graph-section" aria-label="销售项关联图谱">
      <header>
        <h3>关联图谱</h3>
        <span>一层关系 · 点击节点查看依据</span>
      </header>
      <p className="capability-graph-help">
        蓝色为所属产品，橙色为依赖，灰色为普通关联。关联不等于功能满足或兼容承诺。
      </p>
      {error ? (
        <Alert
          type="warning"
          message="关系加载失败"
          description={error}
          action={
            <Button onClick={() => setAttempt((v) => v + 1)}>重试</Button>
          }
        />
      ) : !graph ? (
        <Skeleton active paragraph={{ rows: 3 }} />
      ) : (
        <>
          {graph.warnings.map((w) => (
            <Alert key={w} type="info" message={w} showIcon />
          ))}
          {!graph.nodes.length ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="当前原文与图谱未提供可展示的一层关系"
            />
          ) : (
            <div className="capability-graph-scroll">
              <div className="capability-graph-canvas" style={{ height }}>
                <svg width="600" height={height} aria-hidden="true">
                  <defs>
                    <marker
                      id={marker}
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="5"
                      markerHeight="5"
                      orient="auto-start-reverse"
                    >
                      <path d="M0 0 L10 5 L0 10 z" fill="#b0bdcc" />
                    </marker>
                  </defs>
                  {graph.nodes.map((n, i) => (
                    <path
                      key={n.id}
                      d={`M190 ${height / 2} C225 ${height / 2},225 ${i * 88 + 44},270 ${i * 88 + 44}`}
                      fill="none"
                      stroke={
                        n.relation === "product"
                          ? "#82a7d4"
                          : n.relation === "dependency"
                            ? "#d7b577"
                            : "#bac6d4"
                      }
                      strokeDasharray={
                        n.relation === "related" ? "4 4" : undefined
                      }
                      strokeWidth="1.5"
                      markerEnd={`url(#${marker})`}
                    />
                  ))}
                </svg>
                <div
                  className="capability-graph-root"
                  style={{ top: height / 2 - 45 }}
                >
                  <small>当前销售项</small>
                  <strong>{graph.root.label}</strong>
                </div>
                {graph.nodes.map((n, i) => (
                  <button
                    key={n.id}
                    className={`capability-graph-node relation-${n.relation} ${selected?.id === n.id ? "selected" : ""}`}
                    style={{ top: i * 88 + 8 }}
                    aria-pressed={selected?.id === n.id}
                    onClick={() => setSelected(n)}
                  >
                    <small>{relations[n.relation]}</small>
                    <strong>{n.label}</strong>
                    {!n.path && <span>链接待定位</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
          {selected && (
            <section
              className="capability-related-page"
              aria-label="关联页面原文"
            >
              <Tag
                color={
                  selected.relation === "product"
                    ? "blue"
                    : selected.relation === "dependency"
                      ? "gold"
                      : "default"
                }
              >
                {relations[selected.relation]}
              </Tag>
              <h4>{selected.label}</h4>
              <div className="capability-relation-proof">
                <b>
                  {selected.source === "page"
                    ? `关系依据 · 销售项快照 L${selected.line}`
                    : "关系依据 · 当前 Wiki 图谱"}
                </b>
                <p>{selected.quote}</p>
              </div>
              {selected.path && (
                <p className="capability-source-path">{selected.path}</p>
              )}
              {!selected.path ? (
                <Alert
                  type="info"
                  message={selected.unresolved || "页面路径待确认"}
                />
              ) : pageError ? (
                <Alert
                  type="warning"
                  message="关联页面读取失败"
                  description={pageError}
                />
              ) : !page ? (
                <Skeleton active paragraph={{ rows: 3 }} />
              ) : (
                <>
                  <p className="capability-graph-help">
                    关联页面为本次读取内容，已保存独立快照；不改变原销售项证据。
                  </p>
                  <article className="knowledge-markdown capability-document">
                    <KnowledgeMarkdown text={page.content} />
                  </article>
                  <small>内容版本：{page.hash.slice(0, 16)}</small>
                </>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
