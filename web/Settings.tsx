import { useEffect, useState } from "react";
import {
  Modal,
  Form,
  Input,
  InputNumber,
  Switch,
  Button,
  Alert,
  Divider,
  App as AntApp,
} from "antd";
import { ApiOutlined, CheckCircleOutlined } from "@ant-design/icons";
import type { SettingsView } from "../shared/domain";
import { api, post } from "./api";
export function Settings({
  open,
  onClose,
  onSaved,
  section = "agent",
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  section?: "agent" | "wiki";
}) {
  const [form] = Form.useForm();
  const { message } = AntApp.useApp();
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState("");
  useEffect(() => {
    if (open) {
      setError("");
      setSettings(null);
      void api<SettingsView>("/settings")
        .then((s) => {
          setSettings(s);
          form.setFieldsValue({ ...s, modelApiKey: "", wikiToken: "" });
        })
        .catch((e) => setError(e.message));
    }
  }, [open, form]);
  async function save() {
    setLoading(true);
    try {
      if (!settings) throw new Error("配置尚未加载完成，请稍后重试");
      const fields =
        section === "wiki"
          ? ["wikiBaseUrl", "wikiToken"]
          : [
              "modelBaseUrl",
              "model",
              "modelApiKey",
              "contextWindow",
              "maxOutputTokens",
              "requireRequirementConfirmation",
            ];
      await form.validateFields(fields);
      const values = form.getFieldsValue(fields);
      const payload = {
        ...settings,
        ...values,
        modelApiKey: values.modelApiKey || undefined,
        wikiToken: values.wikiToken || undefined,
      };
      const result = await api<SettingsView>("/settings", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      setSettings(result);
      form.setFieldsValue({ modelApiKey: "", wikiToken: "" });
      message.success("连接配置已保存");
      onSaved();
    } catch (e) {
      if (e instanceof Error) setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  async function test(target: string) {
    setTesting(target);
    try {
      await post("/settings/test", { target });
      message.success(target === "wiki" ? "知识库连接成功" : "模型连接成功");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setTesting("");
    }
  }
  return (
    <Modal
      title={
        <span>
          <ApiOutlined /> {section === "wiki" ? "知识库配置" : "Agent 配置"}
        </span>
      }
      open={open}
      onCancel={onClose}
      width={640}
      footer={
        <>
          <Button onClick={onClose}>关闭</Button>
          <Button
            type="primary"
            disabled={!settings}
            loading={loading}
            onClick={() => void save()}
          >
            保存配置
          </Button>
        </>
      }
    >
      <p className="muted">
        配置仅管理员可修改。密钥在服务端加密保存，留空保留原值。
      </p>
      {error && (
        <Alert
          type="error"
          message={error}
          showIcon
          closable
          onClose={() => setError("")}
        />
      )}
      <Form layout="vertical" form={form} requiredMark={false}>
        <div hidden={section !== "agent"}>
          <Divider orientation="left">模型连接</Divider>
          <Form.Item
            label="OpenAI 兼容 Base URL"
            name="modelBaseUrl"
            rules={[
              { required: true },
              { type: "url", message: "请输入完整 URL" },
            ]}
          >
            <Input placeholder="https://your-provider.example/v1" />
          </Form.Item>
          <div className="form-two">
            <Form.Item
              label="模型名称"
              name="model"
              rules={[{ required: true, message: "请输入模型名称" }]}
            >
              <Input placeholder="服务商提供的模型 ID" />
            </Form.Item>
            <Form.Item
              label={settings?.modelApiKeySet ? "API Key · 已配置" : "API Key"}
              name="modelApiKey"
            >
              <Input.Password
                placeholder={
                  settings?.modelApiKeySet
                    ? "留空保留已保存密钥"
                    : "本地无鉴权模型可留空"
                }
                autoComplete="off"
              />
            </Form.Item>
          </div>
          <div className="form-two">
            <Form.Item label="上下文窗口（tokens）" name="contextWindow">
              <InputNumber min={8192} max={2000000} />
            </Form.Item>
            <Form.Item label="最大输出（tokens）" name="maxOutputTokens">
              <InputNumber min={512} max={32768} />
            </Form.Item>
          </div>
          <Button
            onClick={() => void test("model")}
            loading={testing === "model"}
            icon={<CheckCircleOutlined />}
          >
            测试已保存的模型连接
          </Button>
        </div>
        <div hidden={section !== "wiki"}>
          <Divider orientation="left">产品知识库</Divider>
          <Form.Item
            label="LLM Wiki API 地址"
            name="wikiBaseUrl"
            rules={[
              { required: true },
              { type: "url", message: "请输入完整 URL" },
            ]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            label={
              settings?.wikiTokenSet ? "访问 Token · 已配置" : "访问 Token"
            }
            name="wikiToken"
          >
            <Input.Password
              placeholder="读取类接口允许无鉴权时可留空"
              autoComplete="off"
            />
          </Form.Item>
          <Button
            onClick={() => void test("wiki")}
            loading={testing === "wiki"}
            icon={<CheckCircleOutlined />}
          >
            测试已保存的知识库连接
          </Button>
        </div>
        <div hidden={section !== "agent"}>
          <Divider orientation="left">评估控制</Divider>
          <Form.Item
            label="产品匹配前，由用户确认抽取条款"
            name="requireRequirementConfirmation"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <p className="muted">
            Agent
            只能访问项目工具。长任务自动压缩上下文并接续，任务总预算、超时、循环保护和并发数由部署环境控制。
          </p>
        </div>
      </Form>
    </Modal>
  );
}
