import { useEffect, useRef, useState } from "react";
import { Alert, Button, Form, Input, Typography, Segmented } from "antd";
import {
  ArrowRightOutlined,
  CompassOutlined,
  FileTextOutlined,
  CheckOutlined,
  ApartmentOutlined,
  SafetyCertificateOutlined,
  FileExcelOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  LockOutlined,
} from "@ant-design/icons";
import { post } from "./api";

const walkthrough = [
  {
    title: "需求拆解",
    description: "先读懂需求，再明确核验边界。",
    detail: "预约审批、通行方式、授权时段，分别核查。",
  },
  {
    title: "产品选型",
    description: "从产品概览出发，找到值得比较的方案。",
    detail: "确认产品与版本后，在对应销售项范围内评估。",
  },
  {
    title: "证据核验",
    description: "把判断放回原文里，保留依据与缺口。",
    detail: "相关不等于满足，未明确的条件需要继续核实。",
  },
  {
    title: "成果交付",
    description: "让评估过程，成为可以传递的成果。",
    detail: "条款匹配记录与销售项清单，方便团队审阅。",
  },
];

function AuthShowcase() {
  const root = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(true);
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [visible, setVisible] = useState(
    document.visibilityState === "visible",
  );
  useEffect(() => {
    if (!root.current || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { threshold: 0.1 },
    );
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setReduced(preference.matches);
    const updateVisibility = () =>
      setVisible(document.visibilityState === "visible");
    updatePreference();
    preference.addEventListener("change", updatePreference);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      preference.removeEventListener("change", updatePreference);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);
  const playing = !paused && !reduced && visible && inView;
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(
      () => setStep((s) => (s + 1) % walkthrough.length),
      4600,
    );
    return () => window.clearInterval(timer);
  }, [playing]);
  return (
    <div
      ref={root}
      className={`auth-showcase ${playing ? "is-playing" : "is-paused"}`}
    >
      <div className="auth-showcase-heading">
        <span>
          <span className="auth-demo-dot" />
          一份需求的评估旅程
        </span>
        <button
          type="button"
          className="auth-motion-control"
          disabled={reduced}
          aria-label={
            reduced
              ? "已遵循减少动态效果设置"
              : paused
                ? "播放流程演示"
                : "暂停流程演示"
          }
          aria-pressed={paused || reduced}
          onClick={() => setPaused((p) => !p)}
        >
          {playing ? <PauseOutlined /> : <PlayCircleOutlined />}
          {reduced ? "静态展示" : paused ? "播放" : "暂停"}
        </button>
      </div>
      <div
        className="auth-journey-steps"
        role="group"
        aria-label="评标流程示意步骤"
      >
        {walkthrough.map((item, i) => (
          <button
            type="button"
            key={item.title}
            className={
              step === i ? "is-current" : step > i ? "is-complete" : ""
            }
            aria-pressed={step === i}
            onClick={() => {
              setStep(i);
              setPaused(true);
            }}
          >
            <span className="auth-step-mark">
              {step > i ? <CheckOutlined /> : i + 1}
            </span>
            {item.title}
          </button>
        ))}
      </div>
      <div className="auth-workflow-sheet" data-step={step}>
        <div className="auth-sheet-source">
          <div className="auth-sheet-label">
            <FileTextOutlined /> 招标需求 · 示例
          </div>
          <h3>访客预约与通行管理</h3>
          <p>
            访客通过
            <span className={step === 0 ? "is-highlighted" : ""}>预约审批</span>
            后， 在
            <span className={step === 0 ? "is-highlighted" : ""}>授权时段</span>
            内， 通过
            <span className={step === 0 ? "is-highlighted" : ""}>人脸核验</span>
            进入园区。
          </p>
          <div className="auth-demand-tags">
            <span>预约流程</span>
            <span>身份核验</span>
            <span>权限管理</span>
          </div>
        </div>
        <div className="auth-sheet-bridge" aria-hidden="true">
          <svg viewBox="0 0 88 150" fill="none">
            <path
              d="M0 75H28C44 75 44 35 60 35H88M28 75C44 75 44 115 60 115H88"
              className="auth-connection-track"
            />
            <path
              d="M0 75H28C44 75 44 35 60 35H88M28 75C44 75 44 115 60 115H88"
              className="auth-connection-flow"
            />
          </svg>
        </div>
        <div className="auth-sheet-products">
          <div className="auth-sheet-label">
            <ApartmentOutlined /> 产品与销售项
          </div>
          <div
            className={`auth-product-line ${step === 1 ? "is-highlighted" : ""}`}
          >
            <span className="auth-product-monogram">A</span>
            <div>
              <b>综合安防平台</b>
              <small>候选线索 · 访客管理</small>
            </div>
            <span className="auth-product-candidate">候选</span>
          </div>
          <div
            className={`auth-product-line ${step === 1 ? "is-highlighted" : ""}`}
          >
            <span className="auth-product-monogram alternate">B</span>
            <div>
              <b>园区管理平台</b>
              <small>候选线索 · 人员通行</small>
            </div>
            <span className="auth-product-candidate">候选</span>
          </div>
        </div>
        <div
          className={`auth-evidence-strip ${step === 2 ? "is-highlighted" : ""}`}
        >
          <span className="auth-evidence-icon">
            <SafetyCertificateOutlined />
          </span>
          <div>
            <b>
              {step === 3
                ? "从评估到交付，保留完整记录"
                : "从候选到结论，还需要原文证据"}
            </b>
            <p>{walkthrough[step].detail}</p>
          </div>
        </div>
        <div
          className={`auth-output-strip ${step === 3 ? "is-highlighted" : ""}`}
        >
          <span>
            <FileExcelOutlined /> 销售项清单.xlsx
          </span>
          <span>
            <FileTextOutlined /> 条款匹配记录.xlsx
          </span>
          <CheckOutlined className="auth-output-check" />
        </div>
      </div>
      <div className="auth-showcase-caption">
        <p key={step} className="auth-stage-description">
          {walkthrough[step].description}
        </p>
        <small>流程示意，非真实评估结果</small>
      </div>
    </div>
  );
}
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
    <main className="auth-layout auth-experience">
      <section className="auth-story">
        <div className="auth-wordmark">
          <span className="auth-logo">
            <CompassOutlined />
          </span>
          <b>评标AI</b>
          <span className="auth-brand-description">售前 Agent 工作台</span>
        </div>
        <div className="auth-story-content">
          <h1>
            每一条判断，
            <br />都<span>有据可查</span>。
          </h1>
          <p>
            读懂招标需求，找到合适的产品，核实每一项能力。 与 Agent
            一起，把复杂清单变成清晰的评估方案。
          </p>
          <AuthShowcase />
        </div>
        <div className="auth-story-footer">
          <span>为售前团队的真实工作而设计</span>
          <span>需求 → 产品 → 证据 → 成果</span>
        </div>
      </section>
      <section className="auth-form">
        <div className="auth-mobile-brand">
          <CompassOutlined /> 评标AI
        </div>
        <div className="auth-form-symbol" aria-hidden="true">
          <CompassOutlined />
        </div>
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
            disabled={busy}
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
          disabled={busy}
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
            <Input
              autoComplete="username"
              size="large"
              placeholder="输入你的账号"
            />
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
              placeholder={creating ? "设置至少 10 位的密码" : "输入登录密码"}
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
        <div className="auth-storage-note">
          <LockOutlined />
          <small>账号、文件和会话保存在部署本应用的服务中。</small>
        </div>
      </section>
    </main>
  );
}
