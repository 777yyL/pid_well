import { useEffect, useState } from "react";
import { Modal, Form, Input, Alert, Button, App as AntApp } from "antd";
import { post } from "./api";
export function ProjectModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [form] = Form.useForm();
  const { message } = AntApp.useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setError("");
  }, [open, form]);
  async function create() {
    setBusy(true);
    try {
      const values = await form.validateFields();
      const result = await post<{ id: string }>("/projects", values);
      onCreated(result.id);
      message.success("项目已创建");
    } catch (e) {
      if (e instanceof Error) setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="新建评估项目"
      open={open}
      onCancel={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={busy} onClick={() => void create()}>
            创建项目
          </Button>
        </>
      }
    >
      <p className="muted">
        文件、会话、证据和报告归属于同一个项目。产品知识库由管理员统一设置，无需选择。
      </p>
      {error && (
        <Alert
          type="warning"
          message={error}
          description="如果提示默认知识库未配置，请联系管理员完成知识库设置。"
        />
      )}
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          label="项目名称"
          name="name"
          rules={[{ required: true, message: "请输入项目名称" }]}
        >
          <Input maxLength={120} placeholder="输入招标项目或标段名称" />
        </Form.Item>
        <Form.Item label="项目背景" name="description">
          <Input.TextArea
            rows={3}
            maxLength={5000}
            placeholder="业务场景、已有系统、优先考虑的产品或版本"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
