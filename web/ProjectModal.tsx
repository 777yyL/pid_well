import { useEffect, useState } from "react";
import { Modal, Form, Input, Select, Alert, Button, App as AntApp } from "antd";
import { api, post } from "./api";
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
  const [wiki, setWiki] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setError("");
    void api<{ projects: { id: string; name: string }[] }>("/wiki/projects")
      .then((result) => {
        setWiki(result.projects ?? []);
        if (result.projects?.length === 1)
          form.setFieldValue("wikiProjectId", result.projects[0].id);
      })
      .catch((e) => setError(e.message));
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
        文件、会话、证据和报告归属于同一个项目，支持持续跟进。
      </p>
      {error && (
        <Alert
          type="warning"
          message={error}
          description="可以重试知识库连接，或填写明确的项目 UUID。"
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
        <Form.Item
          label="产品知识库项目"
          name="wikiProjectId"
          rules={[{ required: true, message: "请选择或填写知识库项目 ID" }]}
        >
          {wiki.length ? (
            <Select
              options={wiki.map((p) => ({ value: p.id, label: p.name }))}
            />
          ) : (
            <Input placeholder="LLM Wiki 项目 UUID" />
          )}
        </Form.Item>
      </Form>
    </Modal>
  );
}
