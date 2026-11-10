import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Empty,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Upload,
} from "antd";
import { api, post } from "./api";
import { createRequestId } from "./request-id";
import { SemanticSettings } from "./SemanticSettings";
import { RerankSettings } from "./RerankSettings";
import { types, fields, enums, type Row } from "./knowledge-fields";
import { KnowledgeEditor } from "./KnowledgeEditor";
import { KnowledgeOverview } from "./KnowledgeOverview";

export function KnowledgeAdmin() {
  const { message } = App.useApp();
  const [tab, setTab] = useState("products"),
    [q, setQ] = useState(""),
    [version, setVersion] = useState("");
  const [page, setPage] = useState(1),
    [items, setItems] = useState<Row[]>([]),
    [total, setTotal] = useState(0);
  const [refs, setRefs] = useState<{
    products: Row[];
    versions: Row[];
    categories: Row[];
    sales: Row[];
  }>({ products: [], versions: [], categories: [], sales: [] });
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  const [edit, setEdit] = useState<Row | null>(null),
    [saving, setSaving] = useState(false);
  const [overview, setOverview] = useState<Row | null>(null);
  const [index, setIndex] = useState<{
    total: number;
    enabled: boolean;
    counts: Record<string, number>;
    failures: { name: string; error: string }[];
    engine?: string;
    vectorAvailable?: boolean;
    dimensions?: number[];
  } | null>(null);
  const [form] = Form.useForm();
  const config = types.find((t) => t[0] === tab),
    isEntity = !!config;
  useEffect(() => {
    const c = new AbortController();
    void api<typeof refs>("/knowledge/admin/references", { signal: c.signal })
      .then(setRefs)
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [revision]);
  useEffect(() => {
    if (!isEntity) return;
    const c = new AbortController();
    setLoading(true);
    setError("");
    void api<{ items: Row[]; total: number }>(
      `/knowledge/admin/${tab}?${new URLSearchParams({ q, versionId: version, offset: String((page - 1) * 20), limit: "20" })}`,
      { signal: c.signal },
    )
      .then((r) => {
        if (!c.signal.aborted) {
          setItems(r.items);
          setTotal(r.total);
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [tab, q, version, page, revision, isEntity]);
  useEffect(() => {
    if (tab !== "retrieval") return;
    const c = new AbortController();
    const load = () =>
      void api<NonNullable<typeof index>>("/knowledge/admin/index", {
        signal: c.signal,
      })
        .then(setIndex)
        .catch((e) => {
          if (!c.signal.aborted) setError(e.message);
        });
    load();
    const timer = setInterval(load, 5000);
    return () => {
      c.abort();
      clearInterval(timer);
    };
  }, [tab, revision]);
  function openEditor(row?: Row) {
    const value = row
      ? Object.fromEntries(fields[tab].map((f) => [f, row[f] ?? undefined]))
      : {
          [config![2]]: createRequestId(),
          status: "active",
          price_type: "unknown",
          sort_order: 0,
          product_version_id: version || undefined,
        };
    if (value.effective_date)
      value.effective_date = String(value.effective_date).slice(0, 10);
    form.resetFields();
    form.setFieldsValue(value);
    setEdit({ ...value, isNew: !row });
  }
  async function save() {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const payload = Object.fromEntries(
        fields[tab].map((f) => [
          f,
          values[f] === "" || values[f] === undefined ? null : values[f],
        ]),
      );
      // Defaults are supplied by the form; optional empty fields stay NULL.
      await api(
        `/knowledge/admin/${tab}/${encodeURIComponent(payload[config![2]] as string)}`,
        { method: "PUT", body: JSON.stringify(payload) },
      );
      setEdit(null);
      setRevision((n) => n + 1);
      message.success("已保存，即刻用于新检索");
    } catch (e) {
      if (!(e && typeof e === "object" && "errorFields" in e))
        message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const productName = (id: string) =>
    refs.products.find((p) => p.product_id === id)?.product_code ?? id;
  const versionOptions = refs.versions.map((v) => ({
    value: v.product_version_id,
    label: productName(v.product_id) + " · " + v.version,
  }));
  async function importFile(file: File) {
    try {
      const input = JSON.parse(await file.text());
      await post("/knowledge/admin/import", input);
      setRevision((n) => n + 1);
      message.success("导入完成，检索数据已更新");
    } catch (e) {
      message.error((e as Error).message);
    }
    return false;
  }
  function viewOverview(row: Row) {
    setOverview(row);
  }
  return (
    <section className="knowledge-admin">
      <p className="muted">
        产品与销售项统一维护在
        PostgreSQL，目录保存即生效，检索等待增量索引完成。历史评估保留当时引用的证据。
      </p>
      {error && (
        <Alert
          type="error"
          message={error}
          closable
          onClose={() => setError("")}
        />
      )}
      <Tabs
        activeKey={tab}
        onChange={(t) => {
          setItems([]);
          setTotal(0);
          setTab(t);
          setQ("");
          setPage(1);
        }}
        items={[
          ...types.map((t) => ({ key: t[0], label: t[1] })),
          { key: "retrieval", label: "检索与索引" },
        ]}
      />
      {isEntity ? (
        <>
          <div className="knowledge-toolbar">
            <Input.Search
              aria-label="查询知识记录"
              placeholder="按名称、编码或内容查询"
              allowClear
              onSearch={(s) => {
                setQ(s);
                setPage(1);
              }}
            />
            {["sales", "categories"].includes(tab) && (
              <Select
                aria-label="按产品版本筛选"
                allowClear
                placeholder="全部产品版本"
                value={version || undefined}
                options={versionOptions}
                onChange={(v) => {
                  setVersion(v ?? "");
                  setPage(1);
                }}
              />
            )}
            <Button type="primary" onClick={() => openEditor()}>
              新增{config![1]}
            </Button>
            <Upload
              accept=".json"
              showUploadList={false}
              beforeUpload={importFile}
            >
              <Button>批量导入</Button>
            </Upload>
          </div>
          <Table
            key={tab}
            rowKey={config![2]}
            loading={loading}
            dataSource={items}
            size="middle"
            scroll={{ x: 600 }}
            pagination={{
              current: page,
              pageSize: 20,
              total,
              onChange: setPage,
              showSizeChanger: false,
            }}
            locale={{
              emptyText: (
                <Empty description="暂无记录，可新增或导入 JSON 数据。" />
              ),
            }}
            columns={[
              {
                title: tab === "dependencies" ? "依赖关系" : "名称",
                key: "name",
                render: (_, r: Row) => (
                  <div>
                    <strong>{r.name ?? r.version ?? r.sale_item_id}</strong>
                    <div className="muted">
                      {r.product_code ??
                        r.module_code ??
                        (r.product_id
                          ? productName(r.product_id)
                          : r.depends_on_sale_item_id) ??
                        ""}
                    </div>
                  </div>
                ),
              },
              ...(tab === "products"
                ? [
                    {
                      title: "负责人 / 部门",
                      key: "owner",
                      render: (_: unknown, r: Row) => (
                        <span>
                          {r.owner || "未提供"}
                          <br />
                          <small className="muted">
                            {r.department || "未提供"}
                          </small>
                        </span>
                      ),
                    },
                  ]
                : [
                    {
                      title: "产品版本 / 类型",
                      key: "version",
                      render: (_: unknown, r: Row) =>
                        versionOptions.find(
                          (v) => v.value === r.product_version_id,
                        )?.label ?? r.dependency_type,
                    },
                  ]),
              {
                title: "状态",
                key: "status",
                render: (_, r: Row) =>
                  r.status ? (
                    <Tag color={r.status === "active" ? "blue" : "default"}>
                      {enums.status.find((s) => s.value === r.status)?.label}
                    </Tag>
                  ) : (
                    "—"
                  ),
              },
              {
                title: "操作",
                key: "actions",
                width: 220,
                render: (_, r: Row) => (
                  <Space wrap>
                    <Button type="link" onClick={() => openEditor(r)}>
                      编辑
                    </Button>
                    {tab === "versions" && (
                      <Button
                        type="link"
                        disabled={r.status !== "active"}
                        onClick={() => viewOverview(r)}
                      >
                        版本概览
                      </Button>
                    )}
                    <Popconfirm
                      title="删除此记录？有关联记录时需先解除关联，也可改为停用。"
                      onConfirm={async () => {
                        try {
                          await api(
                            `/knowledge/admin/${tab}/${encodeURIComponent(r[config![2]])}`,
                            { method: "DELETE" },
                          );
                          setRevision((n) => n + 1);
                        } catch (e) {
                          message.error((e as Error).message);
                        }
                      }}
                    >
                      <Button type="link" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        </>
      ) : (
        <>
          {index && (
            <div className="knowledge-index-status">
              <strong>销售项索引</strong>
              <span>共 {index.total} 项</span>
              <span>就绪 {index.counts.ready}</span>
              <span>待更新 {index.counts.pending}</span>
              <span>建立中 {index.counts.indexing}</span>
              <span>失败 {index.counts.failed}</span>
              {index.engine && <span>引擎 {index.engine}</span>}
              {index.vectorAvailable !== undefined && (
                <span>
                  pgvector {index.vectorAvailable ? "可用" : "不可用"}
                </span>
              )}
              {!!index.dimensions?.length && (
                <span>向量维度 {index.dimensions.join("、")}</span>
              )}
              {index.counts.failed > 0 && (
                <Button
                  onClick={async () => {
                    try {
                      await post("/knowledge/admin/index/retry", {});
                      setRevision((n) => n + 1);
                      message.success("已安排重试失败的索引任务");
                    } catch (e) {
                      message.error((e as Error).message);
                    }
                  }}
                >
                  重试失败项
                </Button>
              )}
              <Button
                onClick={async () => {
                  try {
                    await post("/knowledge/admin/index/rebuild", {});
                    setRevision((n) => n + 1);
                  } catch (e) {
                    message.error((e as Error).message);
                  }
                }}
              >
                重建索引
              </Button>
            </div>
          )}
          {!!index?.failures.length && (
            <Alert
              type="warning"
              message="部分向量索引建立失败"
              description={index.failures.slice(0, 5).map((f) => (
                <p key={f.name}>
                  {f.name}：{f.error}
                </p>
              ))}
            />
          )}
          <SemanticSettings />
          <h3 style={{ marginTop: 32 }}>候选精排</h3>
          <RerankSettings />
        </>
      )}
      <KnowledgeEditor
        tab={tab}
        edit={edit}
        form={form}
        refs={refs}
        versionOptions={versionOptions}
        saving={saving}
        onSave={() => void save()}
        onClose={() => setEdit(null)}
      />
      {overview && (
        <KnowledgeOverview
          key={overview.product_version_id}
          overview={overview as { product_version_id: string; version: string }}
          onClose={() => setOverview(null)}
        />
      )}
    </section>
  );
}
