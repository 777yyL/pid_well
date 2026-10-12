import { useRef, useState } from "react";
import {
  Tabs,
  Button,
  Table,
  Tag,
  Empty,
  Drawer,
  Input,
  Select,
  Form,
  Modal,
  App as AntApp,
  Alert,
  Collapse,
  Dropdown,
  Tooltip,
} from "antd";
import {
  UploadOutlined,
  FileTextOutlined,
  DownloadOutlined,
  CheckOutlined,
  ArrowRightOutlined,
  EditOutlined,
  AuditOutlined,
} from "@ant-design/icons";
import type {
  Assessment,
  Document,
  Requirement,
  Snapshot,
  RunEvent,
} from "../shared/domain";
import type { WorkspaceData } from "./useWorkspace";
import { api, post } from "./api";
import { Markdown } from "./Chat";
const levels = {
  exact: { label: "完全满足", color: "success" },
  partial: { label: "部分满足", color: "warning" },
  no_match: { label: "不满足", color: "error" },
} as const;
export function Workpane({
  workspace,
  events,
  onRefresh,
  uploadRef,
}: {
  workspace: WorkspaceData;
  events: RunEvent[];
  onRefresh: () => Promise<void>;
  uploadRef: React.RefObject<(() => void) | null>;
}) {
  const { message } = AntApp.useApp();
  const fileInput = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState("requirements");
  const [uploading, setUploading] = useState(false);
  const [selected, setSelected] = useState<React.Key[]>([]);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<{
    title: string;
    lines: string[];
    start?: number;
    end?: number;
    viewStart?: number;
  } | null>(null);
  const [detail, setDetail] = useState<Assessment | null>(null);
  const [editing, setEditing] = useState(false);
  const [form] = Form.useForm();
  const [audit, setAudit] = useState<Record<string, unknown>[] | null>(null);
  uploadRef.current = () => {
    setTab("documents");
    fileInput.current?.click();
  };
  const requirements = workspace.requirements;
  const pending = requirements.filter((r) => !r.confirmed);
  const results = workspace.assessments;
  const complete =
    requirements.length > 0 &&
    results.length === requirements.length &&
    results.every((r) => r.reviewed) &&
    pending.length === 0;
  async function upload(file?: File) {
    if (!file) return;
    setUploading(true);
    try {
      const data = new FormData();
      data.append("file", file);
      await api(`/projects/${workspace.project.id}/documents`, {
        method: "POST",
        body: data,
      });
      await onRefresh();
      message.success("文件已上传并解析，可开始与 Agent 讨论");
    } catch (e) {
      message.error((e as Error).message);
      await onRefresh();
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  async function confirm() {
    const ids = (selected.length ? selected : pending.map((r) => r.id)).map(
      String,
    );
    setBusy(true);
    try {
      await post(`/projects/${workspace.project.id}/requirements/confirm`, {
        ids,
      });
      setSelected([]);
      await onRefresh();
      message.success("条款已确认，可以让 Agent 继续产品匹配");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function openDocument(id: string, start?: number, end?: number) {
    try {
      const doc = await api<{ name: string; lines: string[] }>(
        `/documents/${id}/source`,
      );
      setSource({
        title: doc.name,
        lines: doc.lines,
        start,
        end,
        viewStart: Math.max(0, (start ?? 1) - 30),
      });
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  function showRequirement(item: Requirement) {
    void openDocument(item.documentId, item.lineStart, item.lineEnd);
  }
  async function openEvidence(snapshotId: string, start: number, end: number) {
    try {
      const snap = await api<Snapshot>(`/snapshots/${snapshotId}`);
      setSource({
        title: snap.path,
        lines: snap.content.split(/\r?\n/),
        start,
        end,
        viewStart: Math.max(0, start - 30),
      });
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  async function exportReport(format: string) {
    setBusy(true);
    try {
      const result = await post<{ id: string }>(
        `/projects/${workspace.project.id}/reports`,
        {
          format: format === "sales" ? "xlsx" : format,
          kind: format === "sales" ? "sales" : "full",
        },
      );
      window.location.assign(`/api/artifacts/${result.id}`);
      await onRefresh();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveReview() {
    if (!detail) return;
    setBusy(true);
    try {
      const values = await form.validateFields();
      const list = (value: string) =>
        value
          .split("\n")
          .map((v) => v.trim())
          .filter(Boolean);
      const updated = {
        ...detail,
        level: values.level,
        note: values.note,
        ok: list(values.ok),
        hard: list(values.hard),
        no: list(values.no),
      };
      await api(
        `/projects/${workspace.project.id}/assessments/${detail.requirementId}`,
        {
          method: "PUT",
          body: JSON.stringify({
            assessment: updated,
            expectedRevision: detail.revision,
          }),
        },
      );
      setEditing(false);
      setDetail(null);
      await onRefresh();
      message.success("人工复核结果已保存，并保留修改记录");
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function openAudit() {
    try {
      setAudit(await api(`/projects/${workspace.project.id}/audit`));
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  const filtered = results.filter(
    (r) =>
      (filter === "all" || r.level === filter) &&
      (!search ||
        [r.requirement_raw, r.requirementId, ...r.sales]
          .join(" ")
          .includes(search)),
  );
  const docs = (
    <div className="tab-content">
      <div className="section-toolbar">
        <div>
          <h3>招标文件</h3>
          <p>原始文件与稳定行号，是整个评估的证据基准。</p>
        </div>
        <Button
          icon={<UploadOutlined />}
          loading={uploading}
          onClick={() => fileInput.current?.click()}
        >
          上传文件
        </Button>
      </div>
      {workspace.documents.length ? (
        workspace.documents.map((doc) => (
          <div className="document-row" key={doc.id}>
            <FileTextOutlined />
            <div>
              <b>{doc.name}</b>
              <small>
                {doc.status === "ready"
                  ? `${doc.line_count ?? doc.lines.length} 行原文 · 已解析`
                  : (doc.error ?? "解析中")}
              </small>
            </div>
            <Tag
              color={
                doc.status === "ready"
                  ? "success"
                  : doc.status === "failed"
                    ? "error"
                    : "processing"
              }
            >
              {doc.status === "ready"
                ? "可评估"
                : doc.status === "failed"
                  ? "解析失败"
                  : "解析中"}
            </Tag>
            {doc.status === "ready" && (
              <Button
                type="text"
                size="small"
                onClick={() => void openDocument(doc.id)}
              >
                查看原文
              </Button>
            )}
            <a
              href={`/api/documents/${doc.id}/download`}
              aria-label={`下载 ${doc.name}`}
            >
              <DownloadOutlined />
            </a>
          </div>
        ))
      ) : (
        <div
          className="upload-empty"
          onClick={() => fileInput.current?.click()}
        >
          <UploadOutlined />
          <h3>上传项目的第一份招标文件</h3>
          <p>
            支持 DOCX、XLSX、PDF、MD、TXT
            <br />
            单个文件最大 25 MB
          </p>
          <Button type="primary" loading={uploading}>
            选择文件
          </Button>
        </div>
      )}
      <Alert
        className="document-note"
        type="info"
        message="扫描 PDF 需先进行 OCR；DOC / XLS 请转换后上传。"
      />
    </div>
  );
  const reqs = (
    <div className="tab-content">
      <div className="section-toolbar">
        <div>
          <h3>原始技术条款</h3>
          <p>
            {requirements.length
              ? `${requirements.length} 条要求 · ${pending.length} 条待确认`
              : "Agent 抽取后的条款会显示在这里。"}
          </p>
        </div>
        {pending.length > 0 && (
          <Button
            type="primary"
            icon={<CheckOutlined />}
            loading={busy}
            onClick={() => void confirm()}
          >
            {selected.length ? `确认 ${selected.length} 条` : "确认全部条款"}
          </Button>
        )}
      </div>
      {pending.length > 0 && (
        <Alert
          className="confirmation-note"
          type="warning"
          showIcon
          message="请核对抽取完整性，再确认进入产品匹配。"
          description="点击条款查看原文；遗漏或错误可在对话中要求 Agent 补充。"
        />
      )}
      <Table
        size="small"
        rowKey="id"
        pagination={{ pageSize: 12, size: "small", showSizeChanger: true }}
        dataSource={requirements}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: setSelected,
          getCheckboxProps: (r) => ({ disabled: r.confirmed }),
        }}
        columns={[
          { title: "编号", dataIndex: "id", width: 68 },
          {
            title: "条款原文",
            dataIndex: "raw",
            render: (value: string, item: Requirement) => (
              <button
                className="text-link requirement-text"
                onClick={() => showRequirement(item)}
              >
                {value}
              </button>
            ),
          },
          {
            title: "状态",
            width: 86,
            render: (_, r) => (
              <Tag bordered={false} color={r.confirmed ? "success" : "warning"}>
                {r.confirmed ? "已确认" : "待确认"}
              </Tag>
            ),
          },
        ]}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="上传文件后，让 Agent 阅读并抽取要求"
            />
          ),
        }}
      />
    </div>
  );
  const assessments = (
    <div className="tab-content">
      <div className="result-stats">
        {(["exact", "partial", "no_match"] as const).map((level) => (
          <button
            key={level}
            className={`stat-item ${level} ${filter === level ? "selected" : ""}`}
            onClick={() => setFilter(filter === level ? "all" : level)}
          >
            <span>{levels[level].label}</span>
            <strong>{results.filter((r) => r.level === level).length}</strong>
            <small>条技术要求</small>
          </button>
        ))}
      </div>
      <div className="section-toolbar">
        <Input.Search
          placeholder="搜索要求或销售项"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
        />
        <Select
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "全部结论" },
            ...Object.entries(levels).map(([value, l]) => ({
              value,
              label: l.label,
            })),
          ]}
        />
      </div>
      <Table
        rowKey="id"
        size="small"
        pagination={{ pageSize: 10, size: "small" }}
        dataSource={filtered}
        columns={[
          { title: "编号", dataIndex: "requirementId", width: 65 },
          {
            title: "需求 / 匹配销售项",
            render: (_, r: Assessment) => (
              <button
                className="text-link assessment-summary"
                onClick={() => setDetail(r)}
              >
                <b>{r.requirement_raw}</b>
                <small>{r.sales.join(" · ") || "未找到对应销售项"}</small>
              </button>
            ),
          },
          {
            title: "结论",
            width: 100,
            render: (_, r: Assessment) => (
              <div>
                <Tag bordered={false} color={levels[r.level].color}>
                  {levels[r.level].label}
                </Tag>
                <small className="muted">
                  {r.source === "human"
                    ? "人工确认"
                    : r.reviewed
                      ? "AI 已复核"
                      : "待复核"}
                </small>
              </div>
            ),
          },
        ]}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="条款确认后，让 Agent 检索并匹配产品"
            />
          ),
        }}
      />
      <div className="export-bar">
        <div>
          <b>正式评估报告</b>
          <small>
            {complete
              ? "所有条款已完成匹配与复核"
              : "全部条款确认、匹配并复核后可导出"}
          </small>
        </div>
        <Dropdown
          menu={{
            items: ["sales", "xlsx", "csv", "html"].map((format) => ({
              key: format,
              label:
                format === "sales"
                  ? "销售项清单 · SPS 模板 XLSX"
                  : format === "xlsx"
                    ? "完整报告 · 含销售清单 XLSX"
                    : format.toUpperCase(),
            })),
            onClick: ({ key }) => void exportReport(key),
          }}
          disabled={!complete || busy}
        >
          <Button
            icon={<DownloadOutlined />}
            loading={busy}
            disabled={!complete}
          >
            导出报告
          </Button>
        </Dropdown>
      </div>
      {workspace.artifacts.length > 0 && (
        <div className="artifact-list">
          <h4>历史报告</h4>
          {workspace.artifacts.map((a) => (
            <a key={a.id} href={`/api/artifacts/${a.id}`}>
              <FileTextOutlined />
              <span>{a.name}</span>
              <small>{new Date(a.created_at).toLocaleString("zh-CN")}</small>
              <DownloadOutlined />
            </a>
          ))}
        </div>
      )}
    </div>
  );
  const activity = (
    <div className="tab-content">
      <div className="section-toolbar">
        <h3>项目分析与留痕</h3>
        <Button icon={<AuditOutlined />} onClick={() => void openAudit()}>
          查看修改记录
        </Button>
      </div>
      {workspace.findings.length ? (
        <Collapse
          items={workspace.findings.map((f) => ({
            key: String(f.id),
            label: f.data.category,
            children: (
              <div className="finding-markdown">
                <Markdown text={f.data.content} />
              </div>
            ),
          }))}
        />
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="建设背景、资质、评分办法和风险分析会保存在这里"
        />
      )}
      <h4 className="activity-heading">执行记录</h4>
      {workspace.runs.map((run) => (
        <div className="execution-row" key={run.id}>
          <span className={`run-dot ${run.status}`} />
          <div>
            <b>{run.input.slice(0, 80)}</b>
            <small>
              {new Date(run.created_at).toLocaleString("zh-CN")} ·{" "}
              {run.turn_count} 轮模型调用
            </small>
            {run.error && <small className="danger">{run.error}</small>}
          </div>
          <Tag>
            {
              (
                {
                  completed: "已完成",
                  running: "执行中",
                  queued: "排队中",
                  failed: "失败",
                  cancelled: "已停止",
                  interrupted: "待恢复",
                } as Record<string, string>
              )[run.status]
            }
          </Tag>
        </div>
      ))}
    </div>
  );
  return (
    <section className="work-pane">
      <header className="pane-header">
        <div>
          <span className="eyebrow">PROJECT KNOWLEDGE</span>
          <h2>证据与评估</h2>
        </div>
        <span className="subtle-label">项目内持续积累</span>
      </header>
      <input
        hidden
        type="file"
        ref={fileInput}
        accept=".docx,.xlsx,.pdf,.md,.txt"
        onChange={(e) => void upload(e.target.files?.[0])}
      />
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: "requirements",
            label: (
              <>
                技术条款{" "}
                <span className="tab-count">{requirements.length}</span>
              </>
            ),
            children: reqs,
          },
          { key: "results", label: "匹配结果", children: assessments },
          {
            key: "documents",
            label: (
              <>
                文件{" "}
                <span className="tab-count">{workspace.documents.length}</span>
              </>
            ),
            children: docs,
          },
          { key: "activity", label: "项目留痕", children: activity },
        ]}
      />
      <Drawer
        title={source?.title}
        open={!!source}
        onClose={() => setSource(null)}
        width={780}
      >
        <div className="source-document">
          {source?.lines
            .slice(source.viewStart ?? 0, (source.viewStart ?? 0) + 300)
            .map((line, localIndex) => {
              const index = localIndex + (source.viewStart ?? 0);
              return (
                <div
                  key={index}
                  className={
                    source.start &&
                    index + 1 >= source.start &&
                    index + 1 <= (source.end ?? source.start)
                      ? "highlight"
                      : ""
                  }
                >
                  <span>L{index + 1}</span>
                  <p>{line}</p>
                </div>
              );
            })}
        </div>
        {source && (
          <div className="source-pagination">
            <Button
              disabled={(source.viewStart ?? 0) === 0}
              onClick={() =>
                setSource({
                  ...source,
                  viewStart: Math.max(0, (source.viewStart ?? 0) - 300),
                })
              }
            >
              上一段
            </Button>
            <span>
              {(source.viewStart ?? 0) + 1}–
              {Math.min((source.viewStart ?? 0) + 300, source.lines.length)} /{" "}
              {source.lines.length} 行
            </span>
            <Button
              disabled={(source.viewStart ?? 0) + 300 >= source.lines.length}
              onClick={() =>
                setSource({
                  ...source,
                  viewStart: (source.viewStart ?? 0) + 300,
                })
              }
            >
              下一段
            </Button>
          </div>
        )}
      </Drawer>
      <Drawer
        title={detail ? `${detail.requirementId} · 评估依据` : ""}
        width={660}
        open={!!detail}
        onClose={() => setDetail(null)}
        extra={
          <Button
            icon={<EditOutlined />}
            onClick={() => {
              if (detail) {
                form.setFieldsValue({
                  ...detail,
                  ok: detail.ok.join("\n"),
                  hard: detail.hard.join("\n"),
                  no: detail.no.join("\n"),
                });
                setEditing(true);
              }
            }}
          >
            人工复核
          </Button>
        }
      >
        {detail && (
          <div className="assessment-detail">
            <Tag color={levels[detail.level].color}>
              {levels[detail.level].label}
            </Tag>
            <Tag>
              {detail.source === "human"
                ? "人工确认"
                : detail.reviewed
                  ? "AI 已复核"
                  : "待复核"}
            </Tag>
            <h3>招标原文</h3>
            <blockquote>{detail.requirement_raw}</blockquote>
            <h3>匹配销售项</h3>
            <p>
              {detail.product} {detail.version}
            </p>
            <div>
              {detail.sales.map((s) => (
                <Tag key={s}>{s}</Tag>
              ))}
            </div>
            <h3>结论说明</h3>
            <p>{detail.note}</p>
            {(["ok", "hard", "no"] as const).map((key) => (
              <section key={key}>
                <h4>
                  {{ ok: "已具备", hard: "需配置 / 定制", no: "明确缺口" }[key]}
                </h4>
                <ul>
                  {detail[key].map((text, index) => (
                    <li key={index}>{text}</li>
                  ))}
                </ul>
              </section>
            ))}
            <h3>五项判断依据</h3>
            <dl>
              {Object.entries(detail.criteria).map(([key, value]) => (
                <div key={key}>
                  <dt>
                    {
                      (
                        {
                          direction: "能力方向",
                          scope: "能力边界",
                          spec: "规格参数",
                          context: "场景适配",
                          delivery: "交付约束",
                        } as Record<string, string>
                      )[key]
                    }
                  </dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <h3>知识库原始证据</h3>
            {detail.evidence.map((e, index) => {
              const snap = workspace.snapshots.find(
                (s) => s.id === e.snapshotId,
              );
              return (
                <div className="evidence-card" key={index}>
                  <blockquote>{e.quote}</blockquote>
                  <button
                    className="text-link"
                    onClick={() =>
                      void openEvidence(e.snapshotId, e.lineStart, e.lineEnd)
                    }
                  >
                    {snap?.path ?? e.snapshotId} · L{e.lineStart}–L{e.lineEnd}
                    <ArrowRightOutlined />
                  </button>
                </div>
              );
            })}
            <h3>交付依赖</h3>
            <p>{detail.dependencies.join("、") || "未列出额外依赖"}</p>
            <p>必选项：{detail.mustSelect.join("、") || "未列出"}</p>
            <small className="muted">
              结果版本 {detail.revision} · 证据快照固定保留
            </small>
          </div>
        )}
      </Drawer>
      <Modal
        title="人工复核"
        open={editing}
        onCancel={() => setEditing(false)}
        onOk={() => void saveReview()}
        confirmLoading={busy}
        okText="保存并确认"
      >
        <Alert type="info" message="人工确认结果将锁定，Agent 不会覆盖。" />
        <Form form={form} layout="vertical">
          <Form.Item name="level" label="匹配结论" rules={[{ required: true }]}>
            <Select
              options={Object.entries(levels).map(([value, l]) => ({
                value,
                label: l.label,
              }))}
            />
          </Form.Item>
          {["ok", "hard", "no"].map((key) => (
            <Form.Item
              key={key}
              name={key}
              label={
                (
                  {
                    ok: "已具备能力",
                    hard: "需配置或定制",
                    no: "明确缺口",
                  } as Record<string, string>
                )[key]
              }
            >
              <Input.TextArea rows={2} placeholder="每行一个能力" />
            </Form.Item>
          ))}
          <Form.Item
            name="note"
            label="复核说明"
            rules={[{ required: true, message: "请填写复核原因" }]}
          >
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
      <Drawer
        title="修改记录"
        open={audit !== null}
        onClose={() => setAudit(null)}
        width={660}
      >
        {audit?.map((row) => (
          <details className="audit-row" key={String(row.id)}>
            <summary>
              {String(row.action)} ·{" "}
              {row.display_name ? String(row.display_name) : "Agent"} ·{" "}
              {new Date(String(row.created_at)).toLocaleString("zh-CN")}
            </summary>
            <pre>{JSON.stringify(row.data, null, 2)}</pre>
          </details>
        ))}
      </Drawer>
    </section>
  );
}
