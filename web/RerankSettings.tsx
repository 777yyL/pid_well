import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Form,
  Input,
  InputNumber,
  Space,
  Switch,
} from "antd";
import { api } from "./api";

type Values = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  candidateLimit: number;
  apiKeySet?: boolean;
};
export function RerankSettings() {
  const [form] = Form.useForm<Values>();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [savedKey, setSavedKey] = useState(false);
  useEffect(() => {
    const control = new AbortController();
    void api<Values>("/settings/rerank", { signal: control.signal })
      .then((value) => {
        if (control.signal.aborted) return;
        const { apiKeySet, ...values } = value;
        form.setFieldsValue({ ...values, apiKey: "" });
        setSavedKey(Boolean(apiKeySet));
      })
      .catch((e) => {
        if (!control.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!control.signal.aborted) setLoading(false);
      });
    return () => control.abort();
  }, [form]);
  async function submit(test = false, clear = false) {
    try {
      const values = await form.validateFields();
      setBusy(test ? "test" : "save");
      const body = {
        ...values,
        apiKey: clear ? "" : values.apiKey || undefined,
      };
      const response = await api<Values & { elapsedMs: number }>(
        "/settings/rerank" + (test ? "/test" : ""),
        {
          method: test ? "POST" : "PUT",
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(values.timeoutMs + 5000),
        },
      );
      if (test) message.success(`Rerank 连接成功 · ${response.elapsedMs} ms`);
      else {
        setSavedKey(Boolean(response.apiKeySet));
        form.setFieldValue("apiKey", "");
        message.success("精排配置已保存");
      }
    } catch (e) {
      if (!(e && typeof e === "object" && "errorFields" in e))
        message.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <section>
      <p className="muted">
        召回候选后，使用独立 Rerank
        模型按需求与正文重新排序。精排分数表示相关性，不表示功能已满足。
      </p>
      {error && <Alert type="error" message={error} showIcon />}
      <Form
        name="knowledge-rerank"
        form={form}
        layout="vertical"
        disabled={loading || Boolean(busy) || Boolean(error)}
        initialValues={{
          enabled: false,
          baseUrl: "",
          model: "",
          candidateLimit: 40,
          timeoutMs: 10000,
        }}
      >
        <Form.Item name="enabled" label="启用精排" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item
          name="baseUrl"
          label="Rerank API 地址"
          extra="兼容 /rerank 接口；填写基础地址（例如 http://服务地址/v1）。"
          rules={[
            {
              validator: async (_, value) => {
                if (!value && !form.getFieldValue("enabled")) return;
                try {
                  const u = new URL(value);
                  if (
                    ["http:", "https:"].includes(u.protocol) &&
                    !u.username &&
                    !u.password &&
                    !u.search &&
                    !u.hash
                  )
                    return;
                } catch {}
                throw new Error("请输入有效的 HTTP/HTTPS 基础地址");
              },
            },
          ]}
        >
          <Input />
        </Form.Item>
        <Form.Item
          name="model"
          label="Rerank 模型名称"
          rules={[
            {
              validator: async (_, value) => {
                if (form.getFieldValue("enabled") && !value?.trim())
                  throw new Error("请输入模型名称");
              },
            },
          ]}
        >
          <Input placeholder="可自定义模型名" />
        </Form.Item>
        <Form.Item
          name="apiKey"
          label="API Key"
          extra={
            savedKey ? "已保存；留空保留原密钥。" : "内部免鉴权服务可留空。"
          }
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Space align="start" wrap>
          <Form.Item
            name="candidateLimit"
            label="精排候选数量"
            rules={[{ required: true }]}
          >
            <InputNumber min={1} max={100} />
          </Form.Item>
          <Form.Item
            name="timeoutMs"
            label="精排超时（毫秒）"
            rules={[{ required: true }]}
          >
            <InputNumber min={1000} max={180000} step={1000} />
          </Form.Item>
        </Space>
        <Space wrap>
          <Button
            type="primary"
            loading={busy === "save"}
            onClick={() => void submit()}
          >
            保存精排配置
          </Button>
          <Button loading={busy === "test"} onClick={() => void submit(true)}>
            测试当前连接
          </Button>
          {savedKey && (
            <Button type="link" danger onClick={() => void submit(false, true)}>
              清除密钥并保存
            </Button>
          )}
        </Space>
      </Form>
    </section>
  );
}
