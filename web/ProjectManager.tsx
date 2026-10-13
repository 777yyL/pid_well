import { useEffect, useState, useCallback } from "react";
import {
  App,
  Modal,
  Input,
  Select,
  Dropdown,
  Empty,
  Pagination,
  Segmented,
  Skeleton,
  Button,
  Space,
  Tag,
  Form,
  Alert,
} from "antd";
import {
  ArrowRightOutlined,
  FolderOpenOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import type { Project, User } from "../shared/domain";
import { api, post } from "./api";

export function ProjectManager({
  open,
  onClose,
  onChanged,
  onOpen,
  onCreate,
  user,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onOpen: (id: string) => void;
  onCreate: () => void;
  user: User;
}) {
  const [rows, setRows] = useState<Project[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [query, setQuery] = useState(""),
    [scope, setScope] = useState("all"),
    [status, setStatus] = useState("active");
  const [editing, setEditing] = useState<Project | null>(null),
    [deleting, setDeleting] = useState<Project | null>(null),
    [confirm, setConfirm] = useState(""),
    [busy, setBusy] = useState(false);
  const [form] = Form.useForm();
  const { message, modal } = App.useApp();
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [query, scope, status, rows]);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setRows(await api<Project[]>("/projects"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  async function change(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      setEditing(null);
      setDeleting(null);
      await load();
      await onChanged();
      message.success("项目已更新");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const visible = rows.filter(
    (p) =>
      (scope !== "mine" || p.owner_id === user.id) &&
      (status === "all" ||
        (status === "archived" ? !!p.archived_at : !p.archived_at)) &&
      `${p.name} ${p.description} ${p.owner_name ?? ""}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  return (
    <>
      {open && (
        <section className="project-hub project-hub-page">
          <header className="project-hub-header">
            <div>
              <span className="project-hub-eyebrow">售前工作空间</span>
              <h1>评估项目</h1>
              <p>从招标清单到评估交付，持续跟进每一个项目。</p>
            </div>
            <Space>
              <Button
                type="primary"
                size="large"
                icon={<PlusOutlined />}
                onClick={onCreate}
              >
                新建项目
              </Button>
              <Button size="large" onClick={onClose}>
                返回工作台
              </Button>
            </Space>
          </header>
          <div className="project-hub-controls">
            <Segmented
              aria-label="项目状态"
              value={status}
              onChange={setStatus}
              options={[
                {
                  value: "active",
                  label: `未归档 · ${rows.filter((p) => !p.archived_at).length}`,
                },
                {
                  value: "archived",
                  label: `已归档 · ${rows.filter((p) => p.archived_at).length}`,
                },
                { value: "all", label: "全部" },
              ]}
            />
            <div className="project-hub-search">
              <Input
                prefix={<SearchOutlined />}
                aria-label="搜索项目"
                placeholder="搜索项目、背景或负责人"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                allowClear
                size="large"
              />
              <Select
                aria-label="项目范围"
                value={scope}
                onChange={setScope}
                options={[
                  { value: "all", label: "全部可访问" },
                  { value: "mine", label: "我负责的" },
                ]}
                size="large"
              />
              <Button
                aria-label="刷新项目"
                icon={<ReloadOutlined />}
                size="large"
                onClick={() => void load()}
                loading={loading}
              />
            </div>
          </div>
          {error && (
            <Alert
              type="error"
              message={error}
              showIcon
              action={<Button onClick={() => void load()}>重试</Button>}
            />
          )}
          <div className="project-hub-list-title">
            <span>
              {status === "archived"
                ? "项目归档"
                : status === "all"
                  ? "全部项目"
                  : "项目列表"}
            </span>
            <small>{visible.length} 个项目 · 按创建时间排序</small>
          </div>
          <div className="project-hub-list" aria-busy={loading}>
            {loading ? (
              <div className="project-hub-loading">
                <Skeleton active paragraph={{ rows: 5 }} />
              </div>
            ) : visible.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  query
                    ? "没有找到匹配的项目"
                    : status === "archived"
                      ? "暂无归档项目"
                      : "还没有可访问的项目"
                }
              >
                <Button
                  onClick={() => {
                    if (query) {
                      setQuery("");
                    } else {
                      onCreate();
                    }
                  }}
                >
                  {query ? "清除搜索" : "新建评估项目"}
                </Button>
              </Empty>
            ) : (
              visible
                .slice(
                  (Math.min(page, Math.max(1, Math.ceil(visible.length / 8))) -
                    1) *
                    8,
                  Math.min(page, Math.max(1, Math.ceil(visible.length / 8))) *
                    8,
                )
                .map((p) => {
                  const manage =
                    user.role === "admin" || p.owner_id === user.id;
                  return (
                    <article
                      className={`project-hub-item ${p.archived_at ? "is-archived" : ""}`}
                      key={p.id}
                    >
                      <div className="project-hub-icon">
                        <FolderOpenOutlined />
                      </div>
                      <div className="project-hub-summary">
                        <div className="project-hub-title">
                          <button onClick={() => onOpen(p.id)}>{p.name}</button>
                          <Tag
                            color={
                              p.active_run
                                ? "processing"
                                : p.archived_at
                                  ? "default"
                                  : "green"
                            }
                          >
                            {p.active_run
                              ? "执行中"
                              : p.archived_at
                                ? "已归档"
                                : "可继续评估"}
                          </Tag>
                        </div>
                        <p className="project-hub-description">
                          {p.description ||
                            "尚未填写项目背景，可在编辑中补充业务场景与评估目标。"}
                        </p>
                        <div className="project-hub-meta">
                          <span className="project-owner-avatar">
                            {(p.owner_name || "成员").slice(0, 1)}
                          </span>
                          <span>{p.owner_name || "项目负责人"}</span>
                          <i />
                          <span>
                            创建于{" "}
                            {new Date(p.created_at).toLocaleDateString("zh-CN")}
                          </span>
                          {p.archived_at && (
                            <>
                              <i />
                              <span>
                                已归档{" "}
                                {new Date(p.archived_at).toLocaleDateString(
                                  "zh-CN",
                                )}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="project-hub-actions">
                        <Button
                          icon={<ArrowRightOutlined />}
                          iconPosition="end"
                          onClick={() => onOpen(p.id)}
                        >
                          {p.archived_at ? "查看成果" : "进入项目"}
                        </Button>
                        {manage && (
                          <Dropdown
                            trigger={["click"]}
                            menu={{
                              items: [
                                {
                                  key: "edit",
                                  label: "编辑项目信息",
                                  disabled:
                                    p.active_run || !!p.archived_at || busy,
                                },
                                {
                                  key: "archive",
                                  label: p.archived_at
                                    ? "恢复项目"
                                    : "归档项目",
                                  disabled: p.active_run || busy,
                                },
                                { type: "divider" },
                                {
                                  key: "delete",
                                  label: "永久删除项目",
                                  danger: true,
                                  disabled: p.active_run || busy,
                                },
                              ],
                              onClick: ({ key }) => {
                                if (key === "edit") {
                                  form.setFieldsValue(p);
                                  setEditing(p);
                                } else if (key === "delete") {
                                  setDeleting(p);
                                  setConfirm("");
                                } else {
                                  modal.confirm({
                                    title: p.archived_at
                                      ? "恢复项目"
                                      : "归档项目",
                                    content: p.archived_at
                                      ? `恢复「${p.name}」后可继续评估。`
                                      : `归档「${p.name}」后保留历史结果，并停止接受新操作。`,
                                    okText: p.archived_at ? "恢复" : "归档",
                                    cancelText: "取消",
                                    onOk: () =>
                                      change(() =>
                                        post(
                                          `/projects/${p.id}/${p.archived_at ? "restore" : "archive"}`,
                                        ),
                                      ),
                                  });
                                }
                              },
                            }}
                          >
                            <Button
                              aria-label={`管理项目 ${p.name}`}
                              icon={<MoreOutlined />}
                            />
                          </Dropdown>
                        )}
                      </div>
                    </article>
                  );
                })
            )}
          </div>
          <footer className="project-hub-footer">
            <span>归档保留全部数据，恢复后可继续协作。</span>
            <Pagination
              current={Math.min(
                page,
                Math.max(1, Math.ceil(visible.length / 8)),
              )}
              total={visible.length}
              pageSize={8}
              onChange={setPage}
              showSizeChanger={false}
              hideOnSinglePage
            />
          </footer>
        </section>
      )}
      <Modal
        title="编辑项目"
        open={!!editing}
        onCancel={() => !busy && setEditing(null)}
        confirmLoading={busy}
        onOk={() =>
          void form
            .validateFields()
            .then((value) =>
              change(() =>
                api(`/projects/${editing!.id}`, {
                  method: "PUT",
                  body: JSON.stringify(value),
                }),
              ),
            )
            .catch(() => {})
        }
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="项目名称"
            rules={[
              { required: true, whitespace: true, message: "请输入项目名称" },
            ]}
          >
            <Input maxLength={120} />
          </Form.Item>
          <Form.Item name="description" label="项目背景">
            <Input.TextArea rows={4} maxLength={5000} />
          </Form.Item>
        </Form>
        <p className="muted">
          知识库绑定保持不变，已有条款、证据和评估结果继续保留。
        </p>
      </Modal>
      <Modal
        title="永久删除项目"
        open={!!deleting}
        onCancel={() => !busy && setDeleting(null)}
        okText="永久删除"
        okButtonProps={{ danger: true, disabled: confirm !== deleting?.name }}
        confirmLoading={busy}
        onOk={() =>
          void change(() =>
            api(`/projects/${deleting!.id}`, {
              method: "DELETE",
              body: JSON.stringify({ name: confirm }),
            }),
          )
        }
      >
        <Alert
          type="warning"
          showIcon
          message="此操作不可撤销"
          description="将删除上传文件、会话与执行记录、条款、证据、评估结果、报告和分享链接。"
        />
        <p>
          请输入项目名称：<b>{deleting?.name}</b>
        </p>
        <Input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="完整项目名称"
        />
      </Modal>
    </>
  );
}
