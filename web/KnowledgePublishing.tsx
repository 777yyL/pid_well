import { useEffect, useState } from "react";
import { Alert, App, Button, Empty, Input, Select, Spin } from "antd";
import { api, post } from "./api";
import "./KnowledgePublishing.css";
type PublishWarning = {
  saleItemId: string;
  product: string;
  version: string;
  sale: string;
  message: string;
};
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
  const [warnings, setWarnings] = useState<PublishWarning[]>([]);
  const [publishError, setPublishError] = useState("");
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
    setPublishError("");
    setWarnings([]);
    try {
      const result = await post<{ warnings: PublishWarning[] }>(
        "/knowledge/releases",
        { wikiProjectId: projectId, name: name.trim() },
      );
      setWarnings(result.warnings ?? []);
      setName("");
      setAttempt((n) => n + 1);
      message.success("知识版本已发布");
    } catch (e) {
      setPublishError((e as Error).message);
    } finally {
      setPublishing(false);
    }
  }
  return (
    <section className="knowledge-publishing" aria-label="结构化知识发布">
      <header className="kp-intro">
        <h3>将导入数据发布为可用知识</h3>
        <p>
          读取 public
          中的知识库数据。发布后，新项目使用固定快照，历史评估保持原版本。
        </p>
      </header>
      <div className="kp-form">
        <label htmlFor="kp-space">目标知识库</label>
        <Select
          id="kp-space"
          aria-label="发布知识库"
          placeholder="选择评估项目使用的知识库"
          disabled={publishing}
          value={
            projects.some((p) => p.id === projectId) ? projectId : undefined
          }
          options={projects.map((p) => ({ value: p.id, label: p.name }))}
          onChange={(id) => {
            setProjectId(id);
            setWarnings([]);
            setPublishError("");
          }}
        />
        <details className="kp-manual">
          <summary>手动输入知识库 ID</summary>
          <Input
            aria-label="知识库 ID"
            placeholder="wikiProjectId"
            value={projectId}
            disabled={publishing}
            onChange={(e) => {
              setProjectId(e.target.value.trim());
              setWarnings([]);
              setPublishError("");
            }}
          />
        </details>
        {projectError && (
          <Alert
            type="warning"
            message="知识库列表加载失败，可手动输入 ID"
            description={projectError}
          />
        )}
      </div>
      {error && (
        <Alert
          type="error"
          message={error}
          action={
            <Button onClick={() => setAttempt((n) => n + 1)}>重试</Button>
          }
        />
      )}
      {loading ? (
        <div className="kp-loading">
          <Spin />
        </div>
      ) : (
        data && (
          <>
            <div className="kp-stats" aria-label="已导入数据统计">
              <div>
                <span>产品</span>
                <strong>{data.draftCounts.products.toLocaleString()}</strong>
              </div>
              <div>
                <span>产品版本</span>
                <strong>{data.draftCounts.versions.toLocaleString()}</strong>
              </div>
              <div>
                <span>销售项</span>
                <strong>{data.draftCounts.saleItems.toLocaleString()}</strong>
              </div>
            </div>
            <div className="kp-form">
              <label htmlFor="kp-name">发布名称</label>
              <div className="kp-publish-action">
                <Input
                  id="kp-name"
                  aria-label="发布版本名称"
                  placeholder="例如：2026 年 10 月产品目录"
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
                  校验并发布
                </Button>
              </div>
              <p className="kp-note">
                仅发布 active
                数据。编码或规格缺失会提示警告，关联错误仍会阻止发布。
              </p>
            </div>
          </>
        )
      )}
      {publishError && (
        <Alert
          type="error"
          showIcon
          message="发布未完成，请修正以下问题"
          description={
            <ul className="kp-issues">
              {publishError
                .replace(/^知识库校验失败：/, "")
                .split("；")
                .map((issue, i) => (
                  <li key={i}>{issue}</li>
                ))}
            </ul>
          }
        />
      )}
      {!!warnings.length && (
        <Alert
          type="warning"
          showIcon
          message={`发布成功，${warnings.length} 个销售项资料待完善`}
          description={
            <details>
              <summary>查看具体产品与销售项</summary>
              <ul className="kp-issues">
                {warnings.map((w) => (
                  <li key={w.saleItemId}>
                    <strong>
                      {w.product} · {w.version} / {w.sale}
                    </strong>
                    <span>{w.message}</span>
                    <code>{w.saleItemId}</code>
                  </li>
                ))}
              </ul>
              <p>缺少技术规格的销售项不能作为完全满足的能力证据。</p>
            </details>
          }
        />
      )}
      {data && (
        <div className="kp-history">
          <div className="kp-history-heading">
            <h4>已发布版本</h4>
            <span>{data.releases.length} 个版本</span>
          </div>
          {data.releases.length ? (
            data.releases.map((r) => (
              <article key={r.id} className="kp-release">
                <strong>{r.name}</strong>
                <span>
                  {new Date(r.created_at).toLocaleString()} · {r.productCount}{" "}
                  个产品 · {r.saleCount} 个销售项
                </span>
                <code>{r.id}</code>
              </article>
            ))
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="尚未发布，填写名称即可创建首个知识版本"
            />
          )}
        </div>
      )}
    </section>
  );
}
