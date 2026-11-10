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
import type { SettingsView } from "../shared/domain";
import { api, post } from "./api";
import { KnowledgeAdmin } from "./KnowledgeAdmin";
import { createRequestId } from "./request-id";
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
  const connectionModels: string[] = Form.useWatch("models", form) ?? [];
  const { message } = AntApp.useApp();
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState("");
  const [profileId, setProfileId] = useState("");
  const [profileName, setProfileName] = useState("");
  function showAgent(s: SettingsView) {
    setProfileId(s.activeProfileId);
    setProfileName(
      s.profiles.find((p) => p.id === s.activeProfileId)?.name ?? "默认连接",
    );
    form.setFieldsValue({
      ...s,
      models:
        s.profiles.find((p) => p.id === s.activeProfileId)?.models ??
        [s.model].filter(Boolean),
      modelApiKey: "",
    });
  }
  async function selectProfile(id: string) {
    setLoading(true);
    try {
      const result = await api<SettingsView>("/settings", {
        method: "PUT",
        body: JSON.stringify({ activeProfileId: id }),
      });
      setSettings(result);
      showAgent(result);
      setError("");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  function newProfile() {
    setProfileId(createRequestId());
    setProfileName("");
    form.setFieldsValue({
      modelBaseUrl: "https://api.openai.com/v1",
      model: "",
      models: [],
      modelApiKey: "",
      contextWindow: 64000,
      maxOutputTokens: 8192,
      requireRequirementConfirmation: true,
    });
  }
  async function removeProfile() {
    setLoading(true);
    try {
      const result = await api<SettingsView>("/settings", {
        method: "PUT",
        body: JSON.stringify({ removeProfileId: profileId }),
      });
      setSettings(result);
      showAgent(result);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    if (open && section === "agent") {
      setError("");
      setSettings(null);
      form.resetFields();
      void api<SettingsView>("/settings", { signal: controller.signal })
        .then((s) => {
          if (controller.signal.aborted) return;
          setSettings(s);
          form.setFieldsValue({ ...s, modelApiKey: "" });
          if (section === "agent") showAgent(s as SettingsView);
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
      if (section === "agent" && !profileName.trim())
        throw new Error("请输入连接名称");
      const fields = [
        "modelBaseUrl",
        "model",
        "models",
        "modelApiKey",
        "contextWindow",
        "maxOutputTokens",
        "requireRequirementConfirmation",
      ];
      await form.validateFields(fields);
      const values = form.getFieldsValue(fields);
      const payload = {
        ...values,
        profileId,
        profileName: profileName.trim(),
        modelApiKey: values.modelApiKey || undefined,
      };
      const result = await api<SettingsView>("/settings", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      setSettings(result);
      if (section === "agent") showAgent(result as SettingsView);
      form.setFieldsValue({ modelApiKey: "" });
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
  if (section === "wiki")
    return (
      <Modal
        title="产品知识库"
        open={open}
        onCancel={onClose}
        width={1180}
        style={{ top: 24 }}
        destroyOnClose
        footer={<Button onClick={onClose}>关闭</Button>}
        styles={{
          body: { maxHeight: "calc(100dvh - 180px)", overflowY: "auto" },
        }}
      >
        {open && <KnowledgeAdmin />}
      </Modal>
    );
  return (
    <Modal
      title={
        <span>
          <ApiOutlined /> Agent 配置
        </span>
      }
      open={open}
      onCancel={onClose}
      width={640}
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
        仅用于你发起的任务，不与其他账号共享。 密钥加密保存，留空保留原值。
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
          <Form.Item label="当前模型连接">
            <div style={{ display: "flex", gap: 8 }}>
              <Select
                style={{ flex: 1 }}
                disabled={loading}
                value={
                  settings &&
                  "profiles" in settings &&
                  settings.profiles.some((p) => p.id === profileId)
                    ? profileId
                    : undefined
                }
                placeholder="新建连接，保存后启用"
                options={
                  settings && "profiles" in settings
                    ? settings.profiles.map((p) => ({
                        value: p.id,
                        label: `${p.name} · ${p.model || "未配置模型"}`,
                      }))
                    : []
                }
                onChange={(id) => void selectProfile(id)}
              />
              <Button onClick={newProfile} disabled={loading}>
                新增连接
              </Button>
              <Button
                danger
                onClick={() => void removeProfile()}
                disabled={
                  loading ||
                  !settings ||
                  !("profiles" in settings) ||
                  settings.profiles.length < 2 ||
                  !settings.profiles.some((p) => p.id === profileId)
                }
              >
                删除
              </Button>
            </div>
          </Form.Item>
          <Form.Item label="连接名称" required>
            <Input
              value={profileName}
              maxLength={100}
              onChange={(e) => setProfileName(e.target.value)}
              placeholder="例如：DeepSeek 内网"
            />
          </Form.Item>
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
              label="此连接可用的模型"
              name="models"
              rules={[
                {
                  required: true,
                  type: "array",
                  min: 1,
                  message: "请输入至少一个模型 ID",
                },
              ]}
              extra="输入模型 ID 后按 Enter，可添加多个；共用此连接的地址和密钥。"
            >
              <Select
                mode="tags"
                tokenSeparators={[",", "，"]}
                placeholder="例如 deepseek-chat、deepseek-reasoner"
                open={false}
                onChange={(models: string[]) => {
                  if (!models.includes(form.getFieldValue("model")))
                    form.setFieldValue("model", models[0] ?? "");
                }}
              />
            </Form.Item>
            <Form.Item
              label="当前使用的模型"
              name="model"
              rules={[{ required: true, message: "请输入模型名称" }]}
            >
              <Select
                placeholder="选择此连接中的模型"
                options={connectionModels.map((model) => ({
                  value: model,
                  label: model,
                }))}
              />
            </Form.Item>
            <Form.Item
              label={
                settings &&
                "modelApiKeySet" in settings &&
                settings.profiles.find((p) => p.id === profileId)
                  ?.modelApiKeySet
                  ? "API Key · 已配置"
                  : "API Key"
              }
              name="modelApiKey"
            >
              <Input.Password
                placeholder={
                  settings &&
                  "modelApiKeySet" in settings &&
                  settings.profiles.find((p) => p.id === profileId)
                    ?.modelApiKeySet
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
            disabled={
              loading ||
              !settings ||
              !("activeProfileId" in settings) ||
              settings.activeProfileId !== profileId
            }
            loading={testing === "model"}
            icon={<CheckCircleOutlined />}
          >
            测试已保存的模型连接
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
