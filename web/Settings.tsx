import { useEffect, useState } from "react";
import {
  Modal,
  Form,
  Input,
  InputNumber,
  Switch,
  Select,
  Button,
  Alert,
  Divider,
  App as AntApp,
} from "antd";
import { ApiOutlined, CheckCircleOutlined } from "@ant-design/icons";
import type { SettingsView, WikiSettingsView } from "../shared/domain";
import { api, post } from "./api";
import { KnowledgePublishing } from "./KnowledgePublishing";
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
  const defaultWikiId = Form.useWatch("defaultWikiProjectId", form);
  const { message } = AntApp.useApp();
  const [settings, setSettings] = useState<
    SettingsView | WikiSettingsView | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState("");
  const [wikiProjects, setWikiProjects] = useState<
    { id: string; name: string }[]
  >([]);
  const [wikiError, setWikiError] = useState("");
  async function loadWikiProjects() {
    try {
      const result = await api<{ projects: { id: string; name: string }[] }>(
        "/wiki/projects",
      );
      setWikiProjects(result.projects ?? []);
      setWikiError("");
    } catch (e) {
      setWikiError((e as Error).message);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    if (open) {
      setError("");
      setSettings(null);
      form.resetFields();
      void api<SettingsView | WikiSettingsView>(
        section === "wiki" ? "/settings/wiki" : "/settings",
        { signal: controller.signal },
      )
        .then((s) => {
          if (controller.signal.aborted) return;
          setSettings(s);
          form.setFieldsValue({ ...s, modelApiKey: "", wikiToken: "" });
          if (section === "wiki") void loadWikiProjects();
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        });
    }
    return () => controller.abort();
  }, [open, section, form]);
  async function save() {
    setLoading(true);
    try {
      if (!settings) throw new Error("配置尚未加载完成，请稍后重试");
      const fields =
        section === "wiki"
          ? ["wikiBaseUrl", "wikiToken", "defaultWikiProjectId"]
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
      const payload =
        section === "wiki"
          ? { ...values, wikiToken: values.wikiToken || undefined }
          : { ...values, modelApiKey: values.modelApiKey || undefined };
      const result = await api<SettingsView | WikiSettingsView>(
        section === "wiki" ? "/settings/wiki" : "/settings",
        {
          method: "PUT",
          body: JSON.stringify(payload),
        },
      );
      setSettings(result);
      form.setFieldsValue({ modelApiKey: "", wikiToken: "" });
      message.success("连接配置已保存");
      onSaved();
      if (section === "wiki") void loadWikiProjects();
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
      width={section === "wiki" ? 760 : 640}
      style={{ top: 32 }}
      styles={{
        body: {
          maxHeight: "calc(100dvh - 220px)",
          overflowY: "auto",
          paddingRight: 8,
        },
      }}
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
        {section === "wiki"
          ? "由管理员统一维护，全体用户的新项目自动使用默认知识库。"
          : "仅用于你发起的任务，不与其他账号共享。"}{" "}
        密钥加密保存，留空保留原值。
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
              label={
                settings &&
                "modelApiKeySet" in settings &&
                settings.modelApiKeySet
                  ? "API Key · 已配置"
                  : "API Key"
              }
              name="modelApiKey"
            >
              <Input.Password
                placeholder={
                  settings &&
                  "modelApiKeySet" in settings &&
                  settings.modelApiKeySet
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
              settings && "wikiTokenSet" in settings && settings.wikiTokenSet
                ? "访问 Token · 已配置"
                : "访问 Token"
            }
            name="wikiToken"
          >
            <Input.Password
              placeholder="读取类接口允许无鉴权时可留空"
              autoComplete="off"
            />
          </Form.Item>
          <Form.Item
            label="默认产品知识库"
            name="defaultWikiProjectId"
            rules={[
              { required: true, message: "请选择默认知识库或填写明确 ID" },
            ]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择所有新项目使用的知识库"
              options={wikiProjects.map((p) => ({
                value: p.id,
                label: `${p.name} · ${p.id}`,
              }))}
            />
          </Form.Item>
          {wikiError && (
            <Alert
              type="warning"
              message="知识库列表暂不可用"
              description={wikiError}
            />
          )}
          <details style={{ marginBottom: 16 }}>
            <summary>手动填写默认知识库 ID</summary>
            <Input
              aria-label="默认知识库 ID"
              value={defaultWikiId ?? ""}
              onChange={(e) =>
                form.setFieldValue(
                  "defaultWikiProjectId",
                  e.target.value.trim(),
                )
              }
              placeholder="明确的知识空间 ID，不能使用 current"
            />
          </details>
          <Button
            onClick={() => void loadWikiProjects()}
            style={{ marginRight: 8 }}
          >
            刷新知识库列表
          </Button>
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
      {open && section === "wiki" && (
        <>
          <Divider orientation="left">结构化知识版本</Divider>
          <KnowledgePublishing
            defaultProjectId={
              settings && "defaultWikiProjectId" in settings
                ? settings.defaultWikiProjectId
                : ""
            }
          />
        </>
      )}
    </Modal>
  );
}
