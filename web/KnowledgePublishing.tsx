import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Empty,
  Input,
  Select,
  Space,
  Spin,
  Tag,
} from "antd";
import { api, post } from "./api";
type ReleaseList = {
  releases: {
    id: string;
    name: string;
    created_at: string;
    productCount: number;
    saleCount: number;
  }[];
  draftCounts: { products: number; versions: number; saleItems: number };
};
export function KnowledgePublishing() {
  const { message } = App.useApp();
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const [data, setData] = useState<ReleaseList | null>(null);
  const [error, setError] = useState("");
  const [projectError, setProjectError] = useState("");
  const [loading, setLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ projects: { id: string; name: string }[] }>("/wiki/projects", {
      signal: controller.signal,
    })
      .then((r) => {
        if (!controller.signal.aborted) {
          setProjects(r.projects);
          setProjectError("");
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setProjectError(e.message);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    setData(null);
    setError("");
    setLoading(false);
    if (!projectId) return;
    const controller = new AbortController();
    setLoading(true);
    void api<ReleaseList>(
      `/knowledge/releases?${new URLSearchParams({ wikiProjectId: projectId })}`,
      { signal: controller.signal },
    )
      .then((r) => {
        if (!controller.signal.aborted) setData(r);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, attempt]);
  async function publish() {
    setPublishing(true);
    try {
      await post("/knowledge/releases", {
        wikiProjectId: projectId,
        name: name.trim(),
      });
      setName("");
      setAttempt((n) => n + 1);
      message.success("知识版本已发布");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setPublishing(false);
    }
  }
  return (
    <section aria-label="结构化知识发布">
      <Alert
        type="info"
        showIcon
        message="数据库导入后发布"
        description="由管理员将产品、产品版本、销售项分类、销售项、销售项依赖这 5 张表的数据导入数据库，仅将 status=active 的记录发布为不可变知识版本。新项目开始选型时固定版本；历史项目不会自动切换。"
      />
      <p>选择要发布的知识库</p>
      <Select
        style={{ width: "100%" }}
        aria-label="发布知识库"
        placeholder="选择已有知识库"
        disabled={publishing}
        value={projects.some((p) => p.id === projectId) ? projectId : undefined}
        options={projects.map((p) => ({
          value: p.id,
          label: `${p.name} · ${p.id}`,
        }))}
        onChange={setProjectId}
      />
      {projectError && (
        <p className="muted">
          知识库列表加载失败：{projectError}。可在下方输入实际知识库 ID。
        </p>
      )}
      <Input
        style={{ marginTop: 8 }}
        aria-label="知识库 ID"
        placeholder="或输入实际 wikiProjectId"
        value={projectId}
        disabled={publishing}
        onChange={(e) => setProjectId(e.target.value.trim())}
      />
      {error && (
        <Alert
          style={{ marginTop: 12 }}
          type="error"
          message={error}
          action={
            <Button onClick={() => setAttempt((n) => n + 1)}>重试</Button>
          }
        />
      )}
      {loading ? (
        <Spin style={{ margin: 20 }} />
      ) : (
        data && (
          <>
            <p>
              <Tag>产品 {data.draftCounts.products}</Tag>
              <Tag>版本 {data.draftCounts.versions}</Tag>
              <Tag>销售项 {data.draftCounts.saleItems}</Tag>
            </p>
            <Space.Compact style={{ width: "100%" }}>
              <Input
                aria-label="发布版本名称"
                placeholder="发布名称，例如 2026 年 10 月产品目录"
                maxLength={200}
                disabled={publishing}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Button
                type="primary"
                loading={publishing}
                disabled={
                  !projectId || !name.trim() || !data.draftCounts.products
                }
                onClick={() => void publish()}
              >
                发布版本
              </Button>
            </Space.Compact>
            <h4>已发布版本</h4>
            {data.releases.length ? (
              data.releases.map((r) => (
                <div
                  key={r.id}
                  style={{ borderTop: "1px solid #e3eaf3", padding: "12px 0" }}
                >
                  <strong>{r.name}</strong>
                  <p className="muted" style={{ margin: "5px 0" }}>
                    {new Date(r.created_at).toLocaleString()} · {r.productCount}{" "}
                    个产品 · {r.saleCount} 个销售项
                  </p>
                  <small className="muted">{r.id}</small>
                </div>
              ))
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="尚未发布知识版本"
              />
            )}
          </>
        )
      )}
    </section>
  );
}
