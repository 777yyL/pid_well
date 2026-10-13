import { useState } from "react";
import { Alert, Button, Form, Input, Typography, Segmented } from "antd";
import { ArrowRightOutlined, FileSearchOutlined } from "@ant-design/icons";
import { post } from "./api";
export function Auth({
  setup,
  onSuccess,
}: {
  setup: boolean;
  onSuccess: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState("login");
  const registering = !setup && mode === "register";
  const creating = setup || registering;
  async function submit(values: Record<string, string>) {
    setBusy(true);
    setError("");
    try {
      await post(
        `/auth/${setup ? "setup" : registering ? "register" : "login"}`,
        values,
      );
      onSuccess();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-layout">
      <section className="auth-story">
        <div className="brand">
          <span className="brand-icon">
            <FileSearchOutlined />
          </span>
          <b>标研</b>
          <span>售前 Agent 工作台</span>
        </div>
        <div>
          <p className="eyebrow">FROM REQUIREMENTS TO EVIDENCE</p>
          <h1>
            每一条判断，
            <br />
            都有据可查。
          </h1>
          <p>
            围绕一个项目持续讨论，让 Agent
            阅读招标文件、检索产品知识、核验能力边界，把评估过程留在团队的工作空间。
          </p>
          <div className="auth-principles">
            <span>原文保真</span>
            <span>产品证据</span>
            <span>人工复核</span>
          </div>
        </div>
        <small>为售前团队的真实工作而设计</small>
      </section>
      <section className="auth-form">
        <p className="eyebrow">WORKSPACE ACCESS</p>
        <Typography.Title level={2}>
          {setup
            ? "建立你的工作空间"
            : registering
              ? "加入团队工作空间"
              : "欢迎回来"}
        </Typography.Title>
        <p className="muted">
          {setup
            ? "首次使用，创建管理员账号。随后配置模型和产品知识库。"
            : registering
              ? "注册普通成员账号，开始你的招标评估。"
              : "登录后继续你的项目与评估会话。"}
        </p>
        {error && <Alert type="error" showIcon message={error} />}
        {!setup && (
          <Segmented
            block
            value={mode}
            options={[
              { label: "登录", value: "login" },
              { label: "注册", value: "register" },
            ]}
            onChange={(value) => {
              setMode(value);
              setError("");
            }}
          />
        )}
        <Form
          key={mode}
          layout="vertical"
          onFinish={submit}
          requiredMark={false}
        >
          <Form.Item
            name="username"
            label="账号"
            rules={[
              { required: true, message: "请输入账号" },
              {
                pattern: /^[a-zA-Z0-9_.-]{3,40}$/,
                message: "3–40 位字母、数字、点、下划线或短横线",
              },
            ]}
          >
            <Input autoComplete="username" size="large" />
          </Form.Item>
          {creating && (
            <Form.Item
              name="displayName"
              label="姓名"
              rules={[{ required: true, message: "请输入姓名" }]}
            >
              <Input size="large" maxLength={80} />
            </Form.Item>
          )}
          <Form.Item
            name="password"
            label="密码"
            rules={[
              { required: true, message: "请输入密码" },
              ...(creating ? [{ min: 10, message: "至少 10 个字符" }] : []),
            ]}
          >
            <Input.Password
              autoComplete={creating ? "new-password" : "current-password"}
              size="large"
              maxLength={256}
            />
          </Form.Item>
          {creating && (
            <Form.Item
              name="confirmPassword"
              label="确认密码"
              dependencies={["password"]}
              rules={[
                { required: true, message: "请再次输入密码" },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    return !value || value === getFieldValue("password")
                      ? Promise.resolve()
                      : Promise.reject(new Error("两次密码不一致"));
                  },
                }),
              ]}
            >
              <Input.Password
                autoComplete="new-password"
                size="large"
                maxLength={256}
              />
            </Form.Item>
          )}
          <Button
            type="primary"
            htmlType="submit"
            size="large"
            block
            loading={busy}
            icon={<ArrowRightOutlined />}
            iconPosition="end"
          >
            {setup
              ? "创建工作空间"
              : registering
                ? "注册并进入工作台"
                : "进入工作台"}
          </Button>
        </Form>
        <small className="muted">
          账号、文件和会话保存在部署本应用的服务中。
        </small>
      </section>
    </main>
  );
}
