import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Form,
  Input,
  InputNumber,
  Space,
  Select,
  Switch,
} from "antd";
import { api } from "./api";

type Values = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey?: string;
  revision: string;
  topK: number;
  timeoutMs: number;
  mode: "keyword" | "vector" | "hybrid";
  minSimilarity?: number;
  apiKeySet?: boolean;
};
export function SemanticSettings() {
  const [form] = Form.useForm<Values>();
  const { message } = App.useApp();
  const [savedKey, setSavedKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void api<Values>("/settings/semantic")
      .then((value) => {
        if (!live) return;
        const { apiKeySet, ...values } = value;
        form.setFieldsValue({ ...values, apiKey: "" });
        setSavedKey(Boolean(apiKeySet));
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [form]);
  async function submit(test = false, clearKey = false) {
    try {
      const values = await form.validateFields();
      setBusy(test ? "test" : "save");
      const body = {
        ...values,
        minSimilarity: values.minSimilarity ?? undefined,
        apiKey: clearKey ? "" : values.apiKey || undefined,
      };
      if (test) {
        const result = await api<{ dimensions: number; elapsedMs: number }>(
          "/settings/semantic/test",
          {
            method: "POST",
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(values.timeoutMs + 5000),
          },
        );
        message.success(
          `连接成功 · ${result.dimensions} 维 · ${result.elapsedMs} ms`,
        );
      } else {
        const result = await api<Values>("/settings/semantic", {
          method: "PUT",
          body: JSON.stringify(body),
        });
        setSavedKey(Boolean(result.apiKeySet));
        form.setFieldValue("apiKey", "");
        message.success("语义检索配置已保存，新任务使用最新配置");
      }
    } catch (e) {
      if (!(e && typeof e === "object" && "errorFields" in e))
        message.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <p className="muted">
        供团队统一使用，与个人对话模型独立。优先检索已选产品内的候选销售项，再读取全文核验。
      </p>
      {error && <Alert type="error" message={error} showIcon />}
      <Form
        form={form}
        layout="vertical"
        disabled={loading || Boolean(busy) || Boolean(error)}
        initialValues={{
          enabled: false,
          revision: "1",
          topK: 10,
          timeoutMs: 30000,
          mode: "keyword",
        }}
      >
        <Form.Item name="enabled" label="启用向量服务" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item
          name="baseUrl"
          label="Embedding API 地址"
          rules={[
            {
              validator: async (_, value) => {
                if (!value && !form.getFieldValue("enabled")) return;
                try {
                  const url = new URL(value);
                  if (["http:", "https:"].includes(url.protocol)) return;
                } catch {}
                throw new Error("请输入 HTTP/HTTPS 地址");
              },
            },
          ]}
        >
          <Input placeholder="https://服务地址/v1" />
        </Form.Item>
        <Form.Item
          name="model"
          label="Embedding 模型名称"
          rules={[
            {
              validator: async (_, value) => {
                if (form.getFieldValue("enabled") && !value?.trim())
                  throw new Error("请输入向量模型名称");
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
            savedKey
              ? "已保存密钥；留空保留，输入新密钥替换。"
              : "无需鉴权的内部服务可留空。"
          }
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Space align="start" wrap>
          <Form.Item
            name="mode"
            label="默认检索模式"
            rules={[{ required: true }]}
          >
            <Select
              style={{ width: 180 }}
              options={[
                { value: "keyword", label: "关键词检索" },
                { value: "vector", label: "向量检索" },
                { value: "hybrid", label: "混合检索" },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="topK"
            label="每条候选数量"
            rules={[{ required: true }]}
          >
            <InputNumber min={1} max={100} />
          </Form.Item>
          <Form.Item
            name="minSimilarity"
            label="最低余弦相似度"
            extra="可留空；仅约束向量和混合检索。"
          >
            <InputNumber min={-1} max={1} step={0.05} placeholder="不设阈值" />
          </Form.Item>
          <Form.Item
            name="timeoutMs"
            label="请求超时（毫秒）"
            rules={[{ required: true }]}
          >
            <InputNumber min={1000} max={180000} step={1000} />
          </Form.Item>
          <Form.Item
            name="revision"
            label="向量模型版本"
            rules={[{ required: true }]}
            extra="模型权重或维度改变时更新。"
          >
            <Input style={{ width: 160 }} />
          </Form.Item>
        </Space>
        <Space wrap>
          <Button
            type="primary"
            onClick={() => void submit()}
            loading={busy === "save"}
          >
            保存语义检索配置
          </Button>
          <Button onClick={() => void submit(true)} loading={busy === "test"}>
            测试当前填写的连接
          </Button>
        </Space>
        {savedKey && (
          <Button danger type="link" onClick={() => void submit(false, true)}>
            清除已保存密钥并保存
          </Button>
        )}
        <p className="muted">
          后台自动检查销售项变化并更新索引。向量服务异常会明确报错，不会将关键词结果标成向量结果；检索相关性不等于功能满足程度。
        </p>
      </Form>
    </>
  );
}
