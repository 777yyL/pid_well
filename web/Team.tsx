import { useEffect, useState } from "react";
import {
  Modal,
  Form,
  Input,
  Button,
  Select,
  Divider,
  App as AntApp,
  Tag,
} from "antd";
import type { User } from "../shared/domain";
import { api, post } from "./api";
export function Team({
  open,
  onClose,
  projectId,
  isAdmin,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  isAdmin: boolean;
}) {
  const [users, setUsers] = useState<User[]>([]);
  const [memberId, setMemberId] = useState<string>();
  const [members, setMembers] = useState<
    { id: string; display_name: string }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm();
  const { message } = AntApp.useApp();
  async function reload() {
    const directory = await api<User[]>("/users");
    setUsers(directory);
    if (projectId) setMembers(await api(`/projects/${projectId}/members`));
  }
  useEffect(() => {
    if (open) void reload().catch((e) => message.error(e.message));
  }, [open, projectId]);
  async function create(values: unknown) {
    setBusy(true);
    try {
      await post("/users", values);
      form.resetFields();
      await reload();
      message.success("成员账号已创建，请通过部门内部渠道提供初始密码");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function share() {
    if (!memberId) return;
    setBusy(true);
    try {
      await post(`/projects/${projectId}/members`, { userId: memberId });
      await reload();
      message.success("成员已加入项目");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="团队与项目成员"
      open={open}
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
    >
      {projectId && (
        <>
          <p className="muted">
            项目成员可以查看文件、参与会话和人工复核。仅项目负责人和管理员可以添加成员。
          </p>
          <div className="member-tags">
            {members.map((m) => (
              <Tag key={m.id}>{m.display_name}</Tag>
            ))}
          </div>
          <div className="member-row">
            <Select
              placeholder="选择团队成员"
              value={memberId}
              onChange={setMemberId}
              options={users.map((u) => ({
                value: u.id,
                label: u.display_name,
              }))}
            />
            <Button
              onClick={() => void share()}
              disabled={!memberId}
              loading={busy}
            >
              加入项目
            </Button>
          </div>
        </>
      )}
      {isAdmin && (
        <>
          <Divider orientation="left">创建成员账号</Divider>
          <Form layout="vertical" form={form} onFinish={create}>
            <Form.Item
              label="姓名"
              name="displayName"
              rules={[{ required: true }]}
            >
              <Input maxLength={80} />
            </Form.Item>
            <Form.Item
              label="账号"
              name="username"
              rules={[
                { required: true },
                {
                  pattern: /^[a-zA-Z0-9_.-]{3,40}$/,
                  message: "3–40 位字母、数字或 _.−",
                },
              ]}
            >
              <Input />
            </Form.Item>
            <Form.Item
              label="初始密码"
              name="password"
              rules={[
                { required: true },
                { min: 10, message: "至少 10 个字符" },
              ]}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={busy}>
              创建成员
            </Button>
          </Form>
        </>
      )}
    </Modal>
  );
}
