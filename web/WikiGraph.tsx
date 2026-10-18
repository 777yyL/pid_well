import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Empty, Input, Modal, Skeleton, Space, Tag } from "antd";
import { MinusOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { api } from "./api";
import { KnowledgeMarkdown } from "./KnowledgeReader";
import type { WikiGraphData, WikiGraphNode } from "../shared/wiki-graph";

const kind = (n: WikiGraphNode) =>
  n.path?.includes("/products/")
    ? "产品"
    : n.path?.includes("/sale-items/")
      ? "销售项"
      : n.nodeType === "concept"
        ? "概念"
        : n.nodeType === "source"
          ? "来源"
          : "实体";
const colors: Record<string, string> = {
  产品: "#4279b7",
  销售项: "#4d968a",
  概念: "#c59b51",
  来源: "#907bb5",
  实体: "#6888aa",
};
function layout(data: WikiGraphData, root: string) {
  const positions = data.nodes.map((n, i) => ({
    ...n,
    x: 500 + Math.cos(i * 2.39996) * Math.sqrt(i + 1) * 38,
    y: 280 + Math.sin(i * 2.39996) * Math.sqrt(i + 1) * 30,
  }));
  const byId = new Map(positions.map((n) => [n.id, n]));
  for (let step = 0; step < 100; step++) {
    const forces = new Map(
      positions.map((n) => [
        n.id,
        { x: (500 - n.x) * 0.004, y: (280 - n.y) * 0.004 },
      ]),
    );
    for (let a = 0; a < positions.length; a++)
      for (let b = a + 1; b < positions.length; b++) {
        const p = positions[a],
          q = positions[b],
          dx = p.x - q.x,
          dy = p.y - q.y,
          dist = Math.max(12, Math.hypot(dx, dy));
        const force = 30000 / (dist * dist);
        const fx = (dx / dist) * force,
          fy = (dy / dist) * force;
        forces.get(p.id)!.x += fx;
        forces.get(p.id)!.y += fy;
        forces.get(q.id)!.x -= fx;
        forces.get(q.id)!.y -= fy;
      }
    for (const e of data.edges) {
      const a = byId.get(e.source)!,
        b = byId.get(e.target)!,
        dx = b.x - a.x,
        dy = b.y - a.y,
        dist = Math.max(1, Math.hypot(dx, dy));
      const force = (dist - 140) * 0.006;
      forces.get(a.id)!.x += (dx / dist) * force;
      forces.get(a.id)!.y += (dy / dist) * force;
      forces.get(b.id)!.x -= (dx / dist) * force;
      forces.get(b.id)!.y -= (dy / dist) * force;
    }
    for (const n of positions) {
      if (
        n.path === root ||
        n.id === root.split("/").at(-1)?.replace(/\.md$/, "")
      ) {
        n.x = 500;
        n.y = 280;
        continue;
      }
      const f = forces.get(n.id)!;
      n.x = Math.max(85, Math.min(915, n.x + Math.max(-10, Math.min(10, f.x))));
      n.y = Math.max(50, Math.min(510, n.y + Math.max(-10, Math.min(10, f.y))));
    }
  }
  return positions;
}

export function WikiGraph({
  wikiProjectId,
  path,
  title,
  onClose,
}: {
  wikiProjectId: string;
  path: string;
  title: string;
  onClose: () => void;
}) {
  const initial = path.split("/").at(-1)?.replace(/\.md$/, "") || title;
  const [query, setQuery] = useState(initial),
    [submitted, setSubmitted] = useState(initial);
  const [data, setData] = useState<WikiGraphData | null>(null),
    [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0),
    [zoom, setZoom] = useState(1);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<WikiGraphNode | null>(null);
  const [source, setSource] = useState<string | null>(null),
    [sourceError, setSourceError] = useState(""),
    [readSource, setReadSource] = useState(false);
  const [readPath, setReadPath] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError("");
    setSelected(null);
    setZoom(1);
    void api<WikiGraphData>("/capability/graph", {
      method: "POST",
      body: JSON.stringify({ wikiProjectId, query: submitted, limit: 60 }),
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) {
          setData(value);
          setSelected(value.nodes.find((n) => n.path === path) || null);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [wikiProjectId, submitted, path, attempt]);
  useEffect(() => {
    setReadSource(false);
    setSource(null);
    setSourceError("");
  }, [selected?.id]);
  useEffect(() => {
    if (!readSource || !selected?.path || readPath !== selected.path) return;
    const controller = new AbortController();
    void api<{ content: string }>("/capability/source", {
      method: "POST",
      body: JSON.stringify({ wikiProjectId, path: selected.path }),
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setSource(value.content);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setSourceError(e.message);
      });
    return () => controller.abort();
  }, [readSource, readPath, selected?.path, wikiProjectId]);
  const nodes = useMemo(() => (data ? layout(data, path) : []), [data, path]);
  const positions = new Map(nodes.map((n) => [n.id, n]));
  const neighbors = new Set(
    data?.edges
      .filter((e) => e.source === selected?.id || e.target === selected?.id)
      .flatMap((e) => [e.source, e.target]),
  );
  return (
    <Modal
      open
      title={`知识图谱 · ${title}`}
      width={1180}
      footer={null}
      onCancel={onClose}
      className="wiki-graph-modal"
    >
      <div className="wiki-graph-toolbar">
        <Input.Search
          aria-label="图谱关键词"
          value={query}
          placeholder="图谱关键词，留空可查看知识库图谱"
          onChange={(e) => setQuery(e.target.value)}
          onSearch={() => {
            setSubmitted(query.trim());
            setAttempt((a) => a + 1);
          }}
          enterButton="查询图谱"
          style={{ maxWidth: 450 }}
        />
        <Space>
          <Button
            onClick={() => {
              setQuery("");
              setSubmitted("");
              setAttempt((a) => a + 1);
            }}
          >
            查看知识库图谱
          </Button>
          <Button
            aria-label="缩小图谱"
            icon={<MinusOutlined />}
            onClick={() => setZoom((z) => Math.max(0.5, z - 0.2))}
          />
          <Button
            aria-label="放大图谱"
            icon={<PlusOutlined />}
            onClick={() => setZoom((z) => Math.min(2.4, z + 0.2))}
          />
          <Button
            aria-label="重置图谱缩放"
            icon={<ReloadOutlined />}
            onClick={() => setZoom(1)}
          />
        </Space>
      </div>
      {error ? (
        <Alert
          type="error"
          showIcon
          message="图谱加载失败"
          description={error}
          action={
            <Button onClick={() => setAttempt((a) => a + 1)}>重试</Button>
          }
        />
      ) : !data ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : !data.nodes.length ? (
        <Empty description="此关键词未返回图谱节点，可修改关键词或查看知识库图谱" />
      ) : (
        <>
          <div className="wiki-graph-caption">
            <span>
              {data.nodes.length} 个节点 · {data.edges.length} 条双链关系
              {data.truncated ? " · 已达展示上限，可能未展示完整" : ""}
            </span>
            <span>点击节点查看关联 · 双链不代表依赖或兼容</span>
          </div>
          {!data.edges.length && (
            <Alert
              type="info"
              message="接口本次未返回连线。可点击“查看知识库图谱”扩大范围；不会根据名称猜测关系。"
            />
          )}
          <div className="wiki-graph-stage">
            <svg
              viewBox="0 0 1000 560"
              role="group"
              aria-label="Wiki双链知识图谱"
            >
              <g
                transform={`translate(${500 * (1 - zoom)} ${280 * (1 - zoom)}) scale(${zoom})`}
              >
                {data.edges.map((e) => {
                  const a = positions.get(e.source)!,
                    b = positions.get(e.target)!;
                  const active =
                    e.source === selected?.id || e.target === selected?.id;
                  return (
                    <line
                      key={JSON.stringify([e.source, e.target])}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke={active ? "#638fbe" : "#c7d4e2"}
                      strokeWidth={active ? 2 : 1}
                      opacity={!selected || active ? 1 : 0.35}
                    >
                      <title>
                        {a.label} ↔ {b.label} · {e.label}
                      </title>
                    </line>
                  );
                })}
                {nodes.map((n) => (
                  <g
                    key={n.id}
                    transform={`translate(${n.x} ${n.y})`}
                    role="button"
                    tabIndex={0}
                    aria-label={`查看节点 ${n.label}`}
                    aria-pressed={selected?.id === n.id}
                    onClick={() => setSelected(n)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected(n);
                      }
                    }}
                    className="wiki-graph-svg-node"
                    onMouseEnter={() => setHovered(n.id)}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => setHovered(n.id)}
                    onBlur={() => setHovered(null)}
                    opacity={
                      !selected || selected.id === n.id || neighbors.has(n.id)
                        ? 1
                        : 0.4
                    }
                  >
                    <title>{n.label}</title>
                    <circle
                      r={selected?.id === n.id ? 19 : 12}
                      fill={colors[kind(n)]}
                      stroke="white"
                      strokeWidth="3"
                    />
                    <text
                      visibility={nodes.length <= 12 || selected?.id === n.id || neighbors.has(n.id) || hovered === n.id ? "visible" : "hidden"}
                      y="35"
                      textAnchor="middle"
                      fill="#304d6c"
                      fontSize="12"
                      fontWeight={selected?.id === n.id ? 650 : 400}
                    >
                      {n.label.split(/[（(]/)[0].length > 17
                        ? n.label.split(/[（(]/)[0].slice(0, 16) + "…"
                        : n.label.split(/[（(]/)[0]}
                    </text>
                  </g>
                ))}
              </g>
            </svg>
          </div>
          <div className="wiki-graph-legend">
            {Object.entries(colors).map(([label, color]) => (
              <span key={label}>
                <i style={{ background: color }} />
                {label}
              </span>
            ))}
          </div>
          {selected && (
            <section className="wiki-graph-selection">
              <Tag>{kind(selected)}</Tag>
              <strong>{selected.label}</strong>
              <p className="capability-source-path">
                {selected.path || "接口未提供页面路径"}
              </p>
              <div className="wiki-graph-neighbors">
                {data.edges
                  .filter(
                    (e) => e.source === selected.id || e.target === selected.id,
                  )
                  .map((e) => {
                    const other = data.nodes.find(
                      (n) =>
                        n.id ===
                        (e.source === selected.id ? e.target : e.source),
                    )!;
                    return (
                      <Button
                        key={JSON.stringify([e.source, e.target])}
                        size="small"
                        onClick={() => setSelected(other)}
                      >
                        {other.label}
                      </Button>
                    );
                  })}
              </div>
              {selected.path && (
                <Button
                  style={{ marginTop: 12 }}
                  onClick={() => { setReadPath(selected.path!); setReadSource(true); }}
                  disabled={readSource}
                >
                  查看节点原文
                </Button>
              )}
              {readSource &&
                (sourceError ? (
                  <Alert
                    type="error"
                    message={sourceError}
                    action={
                      <Button
                        onClick={() => {
                          setReadSource(false);
                          setSourceError("");
                        }}
                      >
                        重新读取
                      </Button>
                    }
                  />
                ) : source === null ? (
                  <Skeleton active />
                ) : (
                  <article
                    className="knowledge-markdown capability-document"
                    style={{ marginTop: 16 }}
                  >
                    <KnowledgeMarkdown text={source} />
                  </article>
                ))}
            </section>
          )}
        </>
      )}
    </Modal>
  );
}
