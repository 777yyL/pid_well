import { useState } from "react";
import { Modal, Form, Input, Alert, App as AntApp } from "antd";
import { post } from "./api";
export function Account({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  const { message } = AntApp.useApp();
  async function save() {
    setBusy(true);
    try {
      const values = await form.validateFields();
      await post("/auth/password", {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      form.resetFields();
      message.success("密码已更新，其他设备的登录已失效");
      onClose();
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="账号安全"
      open={open}
      onCancel={onClose}
      onOk={() => void save()}
      confirmLoading={busy}
      okText="更新密码"
    >
      <Alert type="info" message="更新密码后，其他设备需要重新登录。" />
      <Form layout="vertical" form={form}>
        <Form.Item
          label="当前密码"
          name="currentPassword"
          rules={[{ required: true }]}
        >
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item
          label="新密码"
          name="newPassword"
          rules={[{ required: true }, { min: 10, message: "至少 10 个字符" }]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          label="确认新密码"
          name="confirmPassword"
          dependencies={["newPassword"]}
          rules={[
            { required: true },
            ({ getFieldValue }) => ({
              validator: (_, value) =>
                value === getFieldValue("newPassword")
                  ? Promise.resolve()
                  : Promise.reject(new Error("两次输入不一致")),
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
