import { useEffect, useState, useCallback } from "react";
import {
  App,
  Modal,
  Input,
  Select,
  Table,
  Button,
  Space,
  Tag,
  Form,
  Alert,
  Popconfirm,
} from "antd";
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
  const { message } = App.useApp();
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
      <Modal
        title="评估项目管理"
        open={open}
        onCancel={onClose}
        footer={null}
        width={1100}
      >
        <p className="muted">
          搜索项目、维护背景信息，或整理已完成的评估。归档保留数据，永久删除会清理全部关联内容。
        </p>
        <Space wrap className="project-manager-toolbar">
          <Input.Search
            aria-label="搜索项目"
            placeholder="搜索名称、背景或负责人"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            allowClear
          />
          <Select
            aria-label="项目范围"
            value={scope}
            onChange={setScope}
            options={[
              { value: "all", label: "全部可访问" },
              { value: "mine", label: "我的项目" },
            ]}
          />
          <Select
            aria-label="项目状态"
            value={status}
            onChange={setStatus}
            options={[
              { value: "active", label: "未归档" },
              { value: "archived", label: "已归档" },
              { value: "all", label: "全部状态" },
            ]}
          />
          <Button onClick={() => void load()} loading={loading}>
            刷新
          </Button>
          <Button type="primary" onClick={onCreate}>
            新建项目
          </Button>
        </Space>
        {error && <Alert type="error" message={error} showIcon />}
        <Table
          rowKey="id"
          dataSource={visible}
          loading={loading}
          scroll={{ x: 900 }}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          locale={{ emptyText: "没有符合条件的项目" }}
          columns={[
            {
              title: "项目",
              dataIndex: "name",
              render: (_, p) => (
                <div>
                  <b>{p.name}</b>
                  <p className="muted project-description">
                    {p.description || "未填写背景"}
                  </p>
                </div>
              ),
            },
            { title: "负责人", dataIndex: "owner_name", width: 110 },
            {
              title: "创建时间",
              dataIndex: "created_at",
              width: 150,
              render: (v) => new Date(v).toLocaleDateString("zh-CN"),
            },
            {
              title: "状态",
              width: 100,
              render: (_, p) => (
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
                      : "可使用"}
                </Tag>
              ),
            },
            {
              title: "操作",
              width: 280,
              render: (_, p) => {
                const manage = user.role === "admin" || p.owner_id === user.id;
                return (
                  <Space wrap>
                    <Button size="small" onClick={() => onOpen(p.id)}>
                      {p.archived_at ? "查看" : "打开"}
                    </Button>
                    {manage && (
                      <>
                        <Button
                          size="small"
                          disabled={p.active_run || !!p.archived_at || busy}
                          onClick={() => {
                            form.setFieldsValue(p);
                            setEditing(p);
                          }}
                        >
                          编辑
                        </Button>
                        <Popconfirm
                          title={
                            p.archived_at
                              ? "恢复此项目？"
                              : "归档后将停止接受新操作，确认归档？"
                          }
                          onConfirm={() =>
                            change(() =>
                              post(
                                `/projects/${p.id}/${p.archived_at ? "restore" : "archive"}`,
                              ),
                            )
                          }
                        >
                          <Button size="small" disabled={p.active_run || busy}>
                            {p.archived_at ? "恢复" : "归档"}
                          </Button>
                        </Popconfirm>
                        <Button
                          size="small"
                          danger
                          disabled={p.active_run || busy}
                          onClick={() => {
                            setDeleting(p);
                            setConfirm("");
                          }}
                        >
                          删除
                        </Button>
                      </>
                    )}
                  </Space>
                );
              },
            },
          ]}
        />
      </Modal>
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
