import { useRef, useState } from "react";
import {
  coverageLabel,
  accuracySummary,
  assessmentEvidence,
  highRisk,
  selectedContributions,
} from "../shared/accuracy";
import { SourceCoverage } from "./SourceCoverage";
import { VerificationFields } from "./VerificationFields";
import { SubrequirementEditor } from "./SubrequirementEditor";
import {
  Timeline,
  Space,
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
  Pagination,
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
  RunEvent,
} from "../shared/domain";
import type { WorkspaceData } from "./useWorkspace";
import { api, post } from "./api";
import { Markdown } from "./Chat";
import { ProductSelection } from "./ProductSelection";
import { ShareDialog } from "./ShareDialog";
import { KnowledgeReader, KnowledgeMarkdown } from "./KnowledgeReader";
const levels = {
  exact: { label: "完全满足", color: "success" },
  partial: { label: "部分满足", color: "warning" },
  no_match: { label: "不满足", color: "error" },
  unknown: { label: "待确认", color: "processing" },
} as const;
export function Workpane({
  workspace,
  events,
  onRefresh,
  uploadRef,
  guideViewRef,
  onSend,
}: {
  workspace: WorkspaceData;
  events: RunEvent[];
  onRefresh: () => Promise<void>;
  uploadRef: React.RefObject<(() => void) | null>;
  guideViewRef: React.RefObject<((tab: string) => void) | null>;
  onSend: (text: string) => Promise<void>;
}) {
  const { message } = AntApp.useApp();
  const fileInput = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState("requirements");
  guideViewRef.current = setTab;
  const [knowledgePage, setKnowledgePage] = useState(1);
  const [knowledgeSearch, setKnowledgeSearch] = useState("");
  const [knowledge, setKnowledge] = useState<{
    id: string;
    start?: number;
    end?: number;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const uploadLock = useRef(false);
  const [uploadItems, setUploadItems] = useState<
    {
      name: string;
      status: "waiting" | "uploading" | "ready" | "failed";
      error?: string;
    }[]
  >([]);
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
  async function upload(files: File[]) {
    if (!files.length || uploadLock.current) return;
    uploadLock.current = true;
    setUploading(true);
    setTab("documents");
    setUploadItems(
      files.map((file) => ({ name: file.name, status: "waiting" })),
    );
    const projectId = workspace.project.id;
    const projectName = workspace.project.name;
    let succeeded = 0;
    const update = (
      index: number,
      status: "uploading" | "ready" | "failed",
      error?: string,
    ) =>
      setUploadItems((items) =>
        items.map((item, i) =>
          i === index ? { ...item, status, error } : item,
        ),
      );
    try {
      for (const [index, file] of files.entries()) {
        update(index, "uploading");
        try {
          if (!/\.(docx|xlsx|pdf|md|txt)$/i.test(file.name))
            throw new Error(
              "不支持此格式，请使用 DOCX / XLSX / PDF / MD / TXT",
            );
          if (file.size > 25 * 1024 * 1024)
            throw new Error("单个文件不能超过 25 MB");
          const data = new FormData();
          data.append("file", file);
          await api(`/projects/${projectId}/documents`, {
            method: "POST",
            body: data,
          });
          succeeded++;
          update(index, "ready");
        } catch (e) {
          update(
            index,
            "failed",
            e instanceof Error ? e.message : "上传失败，请重新选择该文件重试",
          );
        }
      }
      if (succeeded === files.length)
        message.success(
          `${projectName}：${succeeded} 份文件已上传并解析，可以开始评估`,
        );
      else
        message.warning(
          `${projectName}：成功 ${succeeded} 份，失败 ${files.length - succeeded} 份，请检查文件列表`,
        );
    } finally {
      setUploading(false);
      uploadLock.current = false;
      if (fileInput.current) fileInput.current.value = "";
      try {
        await onRefresh();
      } catch {
        message.warning(
          "上传批次已结束，文件列表刷新失败，请刷新页面查看实际结果，不要重复提交已成功的文件",
        );
      }
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
    setKnowledge({ id: snapshotId, start, end });
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
      await form.validateFields();
      const values = form.getFieldsValue(true);
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
        verification: values.verification ?? detail.verification,
      };
      if (updated.verification) {
        updated.sales = [
          ...new Set(selectedContributions(updated).map((c) => c.sales)),
        ];
        updated.evidence = assessmentEvidence(updated);
      }
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
      (filter === "all" ||
        (filter === "risk" ? highRisk(r) : r.level === filter)) &&
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
          <p>一个子系统一份文件，可一次选择多份；原文及行号分别保留。</p>
        </div>
        <Button
          data-guide="upload"
          icon={<UploadOutlined />}
          loading={uploading}
          onClick={() => fileInput.current?.click()}
        >
          批量上传文件
        </Button>
      </div>
      {!!uploadItems.length && (
        <section aria-label="批量上传进度" aria-live="polite">
          <Alert
            type={
              uploading
                ? "info"
                : uploadItems.some((item) => item.status === "failed")
                  ? "warning"
                  : "success"
            }
            showIcon
            message={
              uploading
                ? `上传解析中：已完成 ${uploadItems.filter((item) => ["ready", "failed"].includes(item.status)).length} / ${uploadItems.length} 份，请等待全部完成后开始评估`
                : `本批次：${uploadItems.filter((item) => item.status === "ready").length} 份成功，${uploadItems.filter((item) => item.status === "failed").length} 份失败`
            }
          />
          {uploadItems
            .filter((item) => uploading || item.status === "failed")
            .map((item, index) => (
              <div className="document-row" key={index}>
                <FileTextOutlined />
                <div>
                  <b>{item.name}</b>
                  {item.error && <small>{item.error}</small>}
                </div>
                <Tag
                  color={
                    item.status === "ready"
                      ? "success"
                      : item.status === "failed"
                        ? "error"
                        : item.status === "uploading"
                          ? "processing"
                          : "default"
                  }
                >
                  {
                    {
                      waiting: "等待上传",
                      uploading: "上传 / 解析中",
                      ready: "已完成",
                      failed: "失败，可重新选择此文件",
                    }[item.status]
                  }
                </Tag>
              </div>
            ))}
        </section>
      )}
      {!!uploadItems.length && !!workspace.documents.length && (
        <h4>项目文件 · {workspace.documents.length} 份</h4>
      )}
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
          <h3>上传项目的子系统招标文件</h3>
          <p>
            支持 DOCX、XLSX、PDF、MD、TXT
            <br />
            可一次选择多份，每个文件最大 25 MB
          </p>
          <Button type="primary" loading={uploading}>
            选择一份或多份文件
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
      <div className="section-toolbar" data-guide="requirements">
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
            data-guide="confirm-requirements"
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
            title: "核验点",
            width: 122,
            render: (_, r) => (
              <SubrequirementEditor
                projectId={workspace.project.id}
                requirement={r}
                refresh={onRefresh}
              />
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
      <Alert
        data-guide="results"
        type="info"
        showIcon
        message={`处理 ${results.length}/${workspace.requirements.length} 条；原文覆盖：${workspace.sourceCoverage?.map((d) => `${d.name} ${coverageLabel(d.status)}，未检查 ${d.uncheckedLines.length} 行`).join("；") || "待检查"}。未知项不计为满足。`}
      />
      <SourceCoverage workspace={workspace} refresh={onRefresh} />
      <div className="result-stats">
        {(["exact", "partial", "no_match", "unknown"] as const).map((level) => (
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
            { value: "risk", label: "高风险 / 历史未核验" },
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
        rowClassName={(r: Assessment) => `assessment-row ${r.level}`}
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
                <Tag
                  className={`assessment-level ${r.level}`}
                  color={levels[r.level].color}
                >
                  {levels[r.level].label}
                </Tag>
                <small
                  className={`review-state ${r.source === "human" ? "human" : r.reviewed ? "reviewed" : "pending"}`}
                >
                  {r.source === "human"
                    ? "人工确认"
                    : r.reviewed
                      ? "AI 自检完成"
                      : "待复核"}
                  {!r.verification ? " · 历史未核验" : ""}
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
      <div className="export-bar" data-guide="export">
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
      <div className="share-entry" data-guide="share">
        <ShareDialog
          projectId={workspace.project.id}
          enabled={
            complete &&
            !workspace.runs.some((run) =>
              ["queued", "running"].includes(run.status),
            )
          }
          onRefresh={onRefresh}
        />
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
      {!!workspace.searchTrace?.length && (
        <>
          <h4 className="activity-heading">销售项检索过程 · 最近 200 次</h4>
          <Timeline
            items={[...workspace.searchTrace].reverse().map((t) => ({
              color: t.action === "product_global_search" ? "orange" : "blue",
              children: (
                <>
                  <Space wrap>
                    <Tag>{t.data.requirementId}</Tag>
                    <b>
                      {t.action === "product_global_search"
                        ? "全局补查"
                        : "产品内检索"}
                    </b>
                    <span className="muted">
                      产品范围 v{t.data.scopeRevision}
                    </span>
                  </Space>
                  <p>关键词：{t.data.query}</p>
                  {t.action === "product_global_search" ? (
                    <p>
                      补查原因：
                      {t.data.reason === "no_match"
                        ? "产品内未命中"
                        : "证据不足"}{" "}
                      · {t.data.explanation}
                    </p>
                  ) : (
                    <p>找到 {t.data.matchCount ?? 0} 个目录内候选</p>
                  )}
                </>
              ),
            }))}
          />
        </>
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
        multiple
        disabled={uploading}
        ref={fileInput}
        accept=".docx,.xlsx,.pdf,.md,.txt"
        onChange={(e) => void upload(Array.from(e.target.files ?? []))}
      />
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: "knowledge",
            label: `知识库 ${workspace.snapshots.length}`,
            children: (
              <div className="knowledge-library">
                <div className="knowledge-library-header">
                  <h3>项目知识库</h3>
                  <p>
                    Agent 已读取的 Markdown 页面与证据快照。点击卡片查看正文。
                  </p>
                  <Input.Search
                    aria-label="搜索知识库来源"
                    placeholder="搜索来源名称或路径"
                    value={knowledgeSearch}
                    onChange={(e) => {
                      setKnowledgeSearch(e.target.value);
                      setKnowledgePage(1);
                    }}
                    allowClear
                  />
                </div>
                <div className="knowledge-card-grid">
                  {workspace.snapshots
                    .filter((s) =>
                      `${s.title ?? ""} ${s.path}`
                        .toLowerCase()
                        .includes(knowledgeSearch.toLowerCase()),
                    )
                    .slice((knowledgePage - 1) * 12, knowledgePage * 12)
                    .map((s) => {
                      const quote = results
                        .flatMap((r) => r.evidence)
                        .find((e) => e.snapshotId === s.id)?.quote;
                      return (
                        <article className="knowledge-small-card" key={s.id}>
                          <span className="knowledge-card-label">
                            <FileTextOutlined /> Markdown · 证据快照
                          </span>
                          <button
                            className="knowledge-card-title"
                            onClick={() => setKnowledge({ id: s.id })}
                          >
                            {s.title ||
                              s.path
                                .split(/[\\/]/)
                                .pop()
                                ?.replace(/\.md$/i, "")}
                          </button>
                          <p className="knowledge-card-path" title={s.path}>
                            {s.path}
                          </p>
                          <div className="knowledge-card-preview">
                            {quote ? (
                              <KnowledgeMarkdown text={quote} />
                            ) : (
                              <p>原文按需加载，查看产品说明与技术规格。</p>
                            )}
                          </div>
                          <Button
                            type="link"
                            onClick={() => setKnowledge({ id: s.id })}
                          >
                            阅读原文 <ArrowRightOutlined />
                          </Button>
                        </article>
                      );
                    })}
                </div>
                {!workspace.snapshots.filter((s) =>
                  `${s.title ?? ""} ${s.path}`
                    .toLowerCase()
                    .includes(knowledgeSearch.toLowerCase()),
                ).length && (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={
                      knowledgeSearch
                        ? "没有匹配的知识库来源"
                        : "Agent 读取知识库后，证据页面将在这里积累"
                    }
                  />
                )}
                <Pagination
                  current={knowledgePage}
                  pageSize={12}
                  total={
                    workspace.snapshots.filter((s) =>
                      `${s.title ?? ""} ${s.path}`
                        .toLowerCase()
                        .includes(knowledgeSearch.toLowerCase()),
                    ).length
                  }
                  onChange={setKnowledgePage}
                  hideOnSinglePage
                  showSizeChanger={false}
                />
              </div>
            ),
          },
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
          {
            key: "products",
            label: "产品选型",
            children: (
              <ProductSelection
                projectId={workspace.project.id}
                scope={workspace.productScope}
                alternatives={workspace.alternatives ?? []}
                locked={
                  results.length > 0 ||
                  workspace.productScope.status === "legacy"
                }
                active={workspace.runs.some(
                  (r) => r.status === "queued" || r.status === "running",
                )}
                onRefresh={onRefresh}
                onSend={onSend}
              />
            ),
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
                form.resetFields();
                form.setFieldsValue({
                  ...detail,
                  verification: detail.verification,
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
                  ? "AI 自检完成"
                  : "待复核"}
              {!detail.verification ? " · 历史未核验" : ""}
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
            <h3>子要求、组合与风险核验</h3>
            <p style={{ whiteSpace: "pre-wrap" }}>{accuracySummary(detail)}</p>
            {(["ok", "hard", "no"] as const).map((key) => (
              <section className={`assessment-finding ${key}`} key={key}>
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
            {assessmentEvidence(detail).map((e, index) => {
              const snap = workspace.snapshots.find(
                (s) => s.id === e.snapshotId,
              );
              return (
                <div className="evidence-card" key={index}>
                  <span className="knowledge-card-label">
                    知识库证据 · Markdown
                  </span>
                  <KnowledgeMarkdown text={e.quote} />
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
        width={820}
        open={editing}
        onCancel={() => setEditing(false)}
        onOk={() => void saveReview()}
        confirmLoading={busy}
        okText="保存并确认"
      >
        <Alert type="info" message="人工确认结果将锁定，Agent 不会覆盖。" />
        <Form form={form} layout="vertical">
          <VerificationFields
            requirement={requirements.find(
              (r) => r.id === detail?.requirementId,
            )}
            snapshots={workspace.snapshots}
            selected={workspace.productScope.selected}
            searchTrace={workspace.searchTrace}
          />
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
      <KnowledgeReader target={knowledge} onClose={() => setKnowledge(null)} />
    </section>
  );
}
