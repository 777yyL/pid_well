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
  Splitter,
} from "antd";
import {
  FileSearchOutlined,
  CompassOutlined,
  PlusOutlined,
  SettingOutlined,
  TeamOutlined,
  LogoutOutlined,
  MessageOutlined,
  ArrowRightOutlined,
  ReloadOutlined,
  FolderOpenOutlined,
  MoreOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  DatabaseOutlined,
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
import { WorkspaceGuide } from "./WorkspaceGuide";
import { guidePhase } from "./workflow-guide";
import { Workpane } from "./Workpane";
import { SharedResult } from "./SharedResult";
import { ProjectManager } from "./ProjectManager";
import { CapabilitySearch } from "./CapabilitySearch";
export function App() {
  const match = window.location.pathname.match(/^\/share\/([^/]+)\/?$/);
  return match ? (
    <SharedResult token={encodeURIComponent(match[1])} />
  ) : (
    <AuthenticatedApp />
  );
}
function AuthenticatedApp() {
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
  const [configSection, setConfigSection] = useState<"agent" | "wiki">("agent");
  const { message } = AntApp.useApp();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(true);
  const [capabilityOpen, setCapabilityOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("workspace.sidebar.collapsed") === "true",
  );
  const [ratio, setRatio] = useState(() => {
    const value = Number(localStorage.getItem("workspace.split"));
    return value >= 25 && value <= 75 ? value : 50;
  });
  const [teamOpen, setTeamOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const upload = useRef<(() => void) | null>(null);
  const guideView = useRef<((tab: string) => void) | null>(null);
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
  const guideWorkspace = state.workspace;
  const guideActive = !!state.activeRun || state.sending;
  const phase = guideWorkspace
    ? guidePhase({
        documents: guideWorkspace.documents,
        requirements: guideWorkspace.requirements,
        assessments: guideWorkspace.assessments,
        scopeStatus: guideWorkspace.productScope.status,
        hasRecommendations:
          guideWorkspace.productScope.recommendations.length > 0,
        active: guideActive,
        archived: !!guideWorkspace.project.archived_at,
        complete:
          guideWorkspace.requirements.length > 0 &&
          guideWorkspace.assessments.length ===
            guideWorkspace.requirements.length &&
          guideWorkspace.assessments.every((r) => r.reviewed) &&
          guideWorkspace.requirements.every((r) => r.confirmed),
      })
    : null;
  return (
    <div className={`workspace-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="评标AI工作台">
          <span className="brand-icon">
            <CompassOutlined />
          </span>
          <b>评标AI</b>
          <span className="brand-subtitle">售前工作空间</span>
        </a>
        <Button
          className="sidebar-toggle"
          type="text"
          aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
          title={collapsed ? "展开侧栏" : "收起侧栏"}
          icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          onClick={() => {
            setCollapsed(!collapsed);
            localStorage.setItem(
              "workspace.sidebar.collapsed",
              String(!collapsed),
            );
          }}
        />
        <nav className="workspace-navigation" aria-label="工作空间导航">
          <button
            aria-label="评估项目"
            title="评估项目"
            className={managerOpen && !capabilityOpen ? "active" : ""}
            onClick={() => {
              setCapabilityOpen(false);
              setManagerOpen(true);
            }}
          >
            <FolderOpenOutlined />
            <span>评估项目</span>
          </button>
          {state.projectId && (
            <button
              aria-label="当前评估"
              title="当前评估"
              className={!managerOpen && !capabilityOpen ? "active" : ""}
              onClick={() => {
                setCapabilityOpen(false);
                setManagerOpen(false);
              }}
            >
              <MessageOutlined />
              <span>当前评估</span>
            </button>
          )}
          <button
            aria-label="能力检索"
            title="能力检索"
            className={capabilityOpen ? "active" : ""}
            onClick={() => setCapabilityOpen(true)}
          >
            <FileSearchOutlined />
            <span>能力检索</span>
          </button>
        </nav>
        {!capabilityOpen && !managerOpen && state.projectId && (
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
                  disabled={!!state.workspace?.project.archived_at}
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
          <nav className="sidebar-utilities" aria-label="配置与团队">
            <button
              aria-label="Agent 配置"
              title="Agent 配置"
              onClick={() => {
                setConfigSection("agent");
                setSettingsOpen(true);
              }}
            >
              <SettingOutlined />
              <span>Agent 配置</span>
            </button>
            {user.role === "admin" && (
              <>
                <button
                  aria-label="知识库配置"
                  title="知识库配置"
                  onClick={() => {
                    setConfigSection("wiki");
                    setSettingsOpen(true);
                  }}
                >
                  <DatabaseOutlined />
                  <span>知识库配置</span>
                </button>
              </>
            )}
            <button
              aria-label="团队与成员"
              title="团队与成员"
              onClick={() => setTeamOpen(true)}
            >
              <TeamOutlined />
              <span>团队与成员</span>
            </button>
          </nav>
          <Dropdown
            trigger={["click"]}
            placement="topLeft"
            menu={{
              items: [
                {
                  key: "account",
                  label: "账号安全",
                  icon: <SettingOutlined />,
                },
                { type: "divider" },
                { key: "logout", label: "退出登录", icon: <LogoutOutlined /> },
              ],
              onClick: ({ key }) => {
                if (key === "account") setAccountOpen(true);
                else void logout();
              },
            }}
          >
            <button className="account-menu-trigger" aria-label="账号与设置">
              <span className="user-avatar">
                {user.display_name.slice(0, 1)}
              </span>
              <span>
                <b>{user.display_name}</b>
                <small>{user.role === "admin" ? "管理员" : "团队成员"}</small>
              </span>
              <MoreOutlined />
            </button>
          </Dropdown>
        </div>
      </aside>
      <main className="workspace-main">
        {capabilityOpen ? (
          <CapabilitySearch />
        ) : managerOpen ? (
          <ProjectManager
            open={managerOpen}
            onClose={() => setManagerOpen(false)}
            user={user}
            onChanged={state.refreshProjects}
            onOpen={(id) => {
              state.setProjectId(id);
              setManagerOpen(false);
            }}
            onCreate={() => setProjectOpen(true)}
          />
        ) : (
          <>
            <header className="workspace-header">
              <div className="breadcrumbs">
                <span>工作空间</span>
                <span>/</span>
                <Select
                  className="header-project-switch"
                  aria-label="切换项目"
                  value={state.projectId || undefined}
                  showSearch
                  optionFilterProp="label"
                  options={state.projects.map((p) => ({
                    value: p.id,
                    label: p.name + (p.archived_at ? " · 已归档" : ""),
                  }))}
                  onChange={(id) => state.setProjectId(id)}
                  placeholder="选择项目"
                  variant="borderless"
                />
              </div>
              <div className="header-actions">
                {state.workspace && (
                  <WorkspaceGuide
                    userId={user.id}
                    projectId={state.workspace.project.id}
                    phase={phase}
                    enabled={
                      !state.loading &&
                      !guideActive &&
                      !state.workspace.project.archived_at &&
                      !settingsOpen &&
                      !projectOpen &&
                      !teamOpen &&
                      !accountOpen
                    }
                    navigate={(tab) => {
                      if (tab) {
                        guideView.current?.(tab);
                        setMobilePane("evidence");
                      } else setMobilePane("chat");
                    }}
                  />
                )}

                <Tooltip title="拖动中间分隔条可调整宽度">
                  <Button
                    className="workspace-reset-layout"
                    size="small"
                    onClick={() => {
                      setRatio(50);
                      localStorage.setItem("workspace.split", "50");
                    }}
                  >
                    恢复等宽
                  </Button>
                </Tooltip>
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
                  先在个人 Agent
                  配置中设置支持工具调用的模型，再开始会话。知识库由管理员统一维护。
                </span>
                {
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => {
                      setConfigSection("agent");
                      setSettingsOpen(true);
                    }}
                  >
                    配置连接
                  </Button>
                }
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
              <Splitter
                className={`workspace-columns mobile-${mobilePane}`}
                onResize={(sizes) => {
                  const total = sizes[0] + sizes[1];
                  if (total) setRatio((sizes[0] / total) * 100);
                }}
                onResizeEnd={(sizes) => {
                  const total = sizes[0] + sizes[1];
                  if (total)
                    localStorage.setItem(
                      "workspace.split",
                      String((sizes[0] / total) * 100),
                    );
                }}
              >
                <Splitter.Panel size={`${ratio}%`} min="25%" max="75%">
                  <Chat
                    archived={!!state.workspace.project.archived_at}
                    connectionError={state.loadError}
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
                </Splitter.Panel>
                <Splitter.Panel size={`${100 - ratio}%`} min="25%" max="75%">
                  <Workpane
                    key={state.projectId}
                    workspace={state.workspace}
                    events={state.events}
                    onRefresh={state.refresh}
                    onSend={state.send}
                    uploadRef={upload}
                    guideViewRef={guideView}
                  />
                </Splitter.Panel>
              </Splitter>
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
              <span>
                知识库 · {state.workspace ? "已绑定项目" : "未绑定项目"}
              </span>
            </footer>
          </>
        )}
      </main>
      <Settings
        section={configSection}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => void loadSettings()}
      />
      <ProjectModal
        open={projectOpen}
        onClose={() => setProjectOpen(false)}
        onCreated={(id) => {
          setProjectOpen(false);
          setManagerOpen(false);
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
