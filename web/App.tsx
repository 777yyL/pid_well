import { useEffect, useRef, useState } from "react";
import {
  App as AntApp,
  Alert,
  Button,
  Dropdown,
  Empty,
  Select,
  Spin,
  Tag,
  Tooltip,
} from "antd";
import {
  FileSearchOutlined,
  PlusOutlined,
  SettingOutlined,
  TeamOutlined,
  LogoutOutlined,
  MessageOutlined,
  ArrowRightOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import type { User, SettingsView } from "../shared/domain";
import { api, post } from "./api";
import { Auth } from "./Auth";
import { useWorkspace } from "./useWorkspace";
import { Settings } from "./Settings";
import { ProjectModal } from "./ProjectModal";
import { Team } from "./Team";
import { Account } from "./Account";
import { Chat } from "./Chat";
import { Workpane } from "./Workpane";
export function App() {
  const [auth, setAuth] = useState<{
    user: User | null;
    needsSetup: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  async function load() {
    setError("");
    try {
      setAuth(await api("/auth/me"));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  if (error)
    return (
      <main className="loading-screen">
        <Alert type="error" message="工作台连接失败" description={error} />
        <Button onClick={() => void load()}>重新连接</Button>
      </main>
    );
  if (!auth)
    return (
      <main className="loading-screen">
        <Spin size="large" tip="连接工作空间" />
      </main>
    );
  if (!auth.user)
    return <Auth setup={auth.needsSetup} onSuccess={() => void load()} />;
  return <WorkspaceShell user={auth.user} onLogout={() => void load()} />;
}
function WorkspaceShell({
  user,
  onLogout,
}: {
  user: User;
  onLogout: () => void;
}) {
  const state = useWorkspace();
  const { message } = AntApp.useApp();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const upload = useRef<(() => void) | null>(null);
  const [mobilePane, setMobilePane] = useState("chat");
  async function loadSettings() {
    try {
      setSettings(await api("/settings"));
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  useEffect(() => {
    void loadSettings();
  }, []);
  async function logout() {
    try {
      await post("/auth/logout");
      onLogout();
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  const conversation = state.workspace?.conversations.find(
    (c) => c.id === state.conversationId,
  );
  return (
    <div className="workspace-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="标研工作台">
          <span className="brand-icon">
            <FileSearchOutlined />
          </span>
          <b>标研</b>
          <span className="brand-subtitle">售前工作空间</span>
        </a>
        <div className="sidebar-section-title">
          <span>评估项目</span>
          <Tooltip title="新建项目">
            <Button
              type="text"
              size="small"
              icon={<PlusOutlined />}
              onClick={() => setProjectOpen(true)}
              aria-label="新建项目"
            />
          </Tooltip>
        </div>
        <div className="project-list">
          {state.projects.map((project) => (
            <button
              key={project.id}
              className={`project-item ${state.projectId === project.id ? "active" : ""}`}
              onClick={() => state.setProjectId(project.id)}
            >
              <span className="project-letter">{project.name.slice(0, 1)}</span>
              <span>{project.name}</span>
            </button>
          ))}
          {state.projects.length === 0 && (
            <p className="sidebar-empty">新建项目，组织文件与评估会话。</p>
          )}
        </div>
        {state.projectId && (
          <>
            <div className="sidebar-divider" />
            <div className="sidebar-section-title">
              <span>项目会话</span>
              <Tooltip title="新会话">
                <Button
                  type="text"
                  size="small"
                  icon={<PlusOutlined />}
                  onClick={() => void state.newConversation()}
                  aria-label="新会话"
                />
              </Tooltip>
            </div>
            <nav className="conversation-list">
              {state.workspace?.conversations.map((item) => (
                <button
                  key={item.id}
                  className={state.conversationId === item.id ? "active" : ""}
                  onClick={() => state.setConversationId(item.id)}
                >
                  <MessageOutlined />
                  <span>{item.title}</span>
                </button>
              ))}
              {!state.workspace?.conversations.length && (
                <p className="sidebar-empty">
                  发出第一条消息后，会话会自动保存。
                </p>
              )}
            </nav>
          </>
        )}
        <div className="sidebar-bottom">
          {user.role === "admin" && (
            <button onClick={() => setSettingsOpen(true)}>
              <SettingOutlined />
              <span>连接与运行设置</span>
              {!settings?.model && <span className="attention-dot" />}
            </button>
          )}
          <button onClick={() => setTeamOpen(true)}>
            <TeamOutlined />
            <span>团队与成员</span>
          </button>
          <button onClick={() => setAccountOpen(true)}>
            <SettingOutlined />
            <span>账号安全</span>
          </button>
          <div className="user-row">
            <span className="user-avatar">{user.display_name.slice(0, 1)}</span>
            <div>
              <b>{user.display_name}</b>
              <small>{user.role === "admin" ? "管理员" : "团队成员"}</small>
            </div>
            <Tooltip title="退出登录">
              <Button
                type="text"
                size="small"
                icon={<LogoutOutlined />}
                onClick={() => void logout()}
                aria-label="退出登录"
              />
            </Tooltip>
          </div>
        </div>
      </aside>
      <main className="workspace-main">
        <header className="workspace-header">
          <div className="breadcrumbs">
            <span>工作空间</span>
            <span>/</span>
            <b>{state.workspace?.project.name ?? "项目"}</b>
          </div>
          <div className="header-actions">
            <Tag bordered={false}>售前评估</Tag>
            {state.projectId && (
              <Button
                size="small"
                icon={<TeamOutlined />}
                onClick={() => setTeamOpen(true)}
              >
                项目成员
              </Button>
            )}
            <Button
              size="small"
              icon={<PlusOutlined />}
              onClick={() => setProjectOpen(true)}
            >
              新建项目
            </Button>
          </div>
        </header>
        {settings && !settings.model && (
          <div className="setup-banner">
            <SettingOutlined />
            <span>
              先连接支持工具调用的模型，再开始 Agent 会话。产品知识库可通过 LLM
              Wiki API 接入。
            </span>
            {user.role === "admin" && (
              <Button
                size="small"
                type="primary"
                onClick={() => setSettingsOpen(true)}
              >
                配置连接
              </Button>
            )}
          </div>
        )}
        {state.loadError && (
          <Alert
            className="workspace-error"
            type="error"
            showIcon
            message={state.loadError}
            action={
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={() =>
                  void Promise.all([
                    state.refreshProjects(),
                    state.refresh(),
                  ]).catch((e) => message.error(e.message))
                }
              >
                重试
              </Button>
            }
          />
        )}
        <div className="mobile-switch">
          <Button
            type={mobilePane === "chat" ? "primary" : "default"}
            onClick={() => setMobilePane("chat")}
          >
            Agent 会话
          </Button>
          <Button
            type={mobilePane === "evidence" ? "primary" : "default"}
            onClick={() => setMobilePane("evidence")}
          >
            证据与评估
          </Button>
        </div>
        {state.loading ? (
          <div className="loading-screen">
            <Spin size="large" />
          </div>
        ) : state.workspace ? (
          <div className={`workspace-columns mobile-${mobilePane}`}>
            <Chat
              messages={state.messages}
              events={state.events}
              streaming={state.streaming}
              conversation={conversation}
              activeRun={state.activeRun}
              latestRun={state.latestRun}
              sending={state.sending}
              onSend={state.send}
              onCancel={() => void state.cancel()}
              onUpload={() => upload.current?.()}
              hasDocuments={state.workspace.documents.some(
                (d) => d.status === "ready",
              )}
            />
            <Workpane
              key={state.projectId}
              workspace={state.workspace}
              events={state.events}
              onRefresh={state.refresh}
              uploadRef={upload}
            />
          </div>
        ) : (
          <div className="first-project">
            <div className="first-project-graphic">
              <FileSearchOutlined />
            </div>
            <p className="eyebrow">YOUR PRESALES WORKSPACE</p>
            <h1>让评估成为可持续的团队工作。</h1>
            <p>
              每个项目都有自己的文件、对话、产品证据和复核记录。
              <br />
              从创建第一个项目开始。
            </p>
            <Button
              type="primary"
              size="large"
              icon={<ArrowRightOutlined />}
              iconPosition="end"
              onClick={() => setProjectOpen(true)}
            >
              新建评估项目
            </Button>
            <div className="first-project-steps">
              <span>
                <b>01</b> 上传招标清单
              </span>
              <span>
                <b>02</b> 与 Agent 协作
              </span>
              <span>
                <b>03</b> 确认并交付报告
              </span>
            </div>
          </div>
        )}
        <footer className="workspace-status">
          <span className="status-dot" />
          <span>会话与结果持久保存</span>
          <span>
            {settings?.model ? `模型 · ${settings.model}` : "模型待配置"}
          </span>
          <span>知识库 · {state.workspace ? "已绑定项目" : "未绑定项目"}</span>
        </footer>
      </main>
      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => void loadSettings()}
      />
      <ProjectModal
        open={projectOpen}
        onClose={() => setProjectOpen(false)}
        onCreated={(id) => {
          setProjectOpen(false);
          void state.refreshProjects().then(() => state.setProjectId(id));
        }}
      />
      <Team
        open={teamOpen}
        onClose={() => setTeamOpen(false)}
        projectId={state.projectId}
        isAdmin={user.role === "admin"}
      />
      <Account open={accountOpen} onClose={() => setAccountOpen(false)} />
    </div>
  );
}
