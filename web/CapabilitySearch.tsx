import { useEffect, useRef, useState } from "react";
import {
  App,
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Modal,
  Select,
  Segmented,
  Space,
  Spin,
  Tag,
} from "antd";
import {
  ArrowRightOutlined,
  CopyOutlined,
  FileSearchOutlined,
  PlusOutlined,
  SearchOutlined,
  StopOutlined,
} from "@ant-design/icons";
import type {
  CapabilityResult,
  CapabilitySession,
  CapabilityTurn,
} from "../shared/capability";
import { api, post } from "./api";
import { KnowledgeMarkdown } from "./KnowledgeReader";
import { CapabilityGraph } from "./CapabilityGraph";

const labels = {
  supported: { text: "有明确依据", color: "success" },
  partial: { text: "部分有依据", color: "warning" },
  candidate: { text: "相关候选 · 待核验", color: "processing" },
  unsupported: { text: "明确不支持", color: "error" },
} as const;
const checkLabels = {
  supported: "有依据",
  partial: "部分有依据",
  unsupported: "明确限制",
  unknown: "待确认",
};
const deliveryLabels = {
  native: "原生功能",
  configuration: "配置实现",
  integration: "需要集成",
  customization: "需要定制",
  external: "依赖外部条件",
  unknown: "交付待确认",
};
type SessionBrief = { id: string; title: string; status: string };

export function CapabilitySearch() {
  const { message } = App.useApp();
  const [libraries, setLibraries] = useState<{ id: string; name: string }[]>(
    [],
  );
  const [library, setLibrary] = useState("");
  const [question, setQuestion] = useState("");
  const [product, setProduct] = useState("");
  const [version, setVersion] = useState("");
  const [session, setSession] = useState<CapabilitySession | null>(null);
  const [history, setHistory] = useState<SessionBrief[]>([]);
  const [activeTurn, setActiveTurn] = useState("");
  const [followup, setFollowup] = useState("");
  const [focused, setFocused] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [detail, setDetail] = useState<{
    result: CapabilityResult;
    turnId: string;
    sessionId: string;
  } | null>(null);
  const [page, setPage] = useState<{
    content: string;
    path: string;
    hash: string;
  } | null>(null);
  const [pageError, setPageError] = useState("");
  const [sourceMode, setSourceMode] = useState("read");
  useEffect(() => setSourceMode("read"), [detail?.result.path]);
  const selectedSession = useRef<string | null>(null);
  const refreshHistory = () =>
    api<SessionBrief[]>("/capability/sessions").then(setHistory);
  useEffect(() => {
    let ignore = false;
    void Promise.allSettled([
      api<{ projects: { id: string; name: string }[] }>("/wiki/projects"),
      api<SessionBrief[]>("/capability/sessions"),
    ]).then(([wiki, recent]) => {
      if (ignore) return;
      if (wiki.status === "fulfilled") {
        const list = Array.isArray(wiki.value.projects)
          ? wiki.value.projects
          : [];
        setLibraries(list);
        setLibrary((value) => value || list[0]?.id || "");
      } else
        setError(
          `知识库列表读取失败：${wiki.reason instanceof Error ? wiki.reason.message : "请检查连接"}`,
        );
      if (recent.status === "fulfilled") setHistory(recent.value);
    });
    return () => {
      ignore = true;
      selectedSession.current = null;
    };
  }, []);
  const running = session?.status === "running";
  useEffect(() => {
    if (!session || !running) return;
    const id = session.id;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<CapabilitySession>(`/capability/sessions/${id}`);
        if (alive && selectedSession.current === id) {
          setSession(next);
          setPollError("");
          if (next.status !== "running") void refreshHistory().catch(() => {});
        }
      } catch (e) {
        if (alive)
          setPollError(e instanceof Error ? e.message : "进度同步失败");
      } finally {
        if (alive) timer = setTimeout(poll, 1800);
      }
    };
    timer = setTimeout(poll, 800);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [session?.id, running]);
  useEffect(() => {
    setPage(null);
    setPageError("");
    if (!detail) return;
    const controller = new AbortController();
    void api<{ content: string; path: string; hash: string }>(
      `/capability/sessions/${detail.sessionId}/pages/${detail.result.pageId}`,
      { signal: controller.signal },
    )
      .then(setPage)
      .catch((e) => {
        if (!controller.signal.aborted) setPageError(e.message);
      });
    return () => controller.abort();
  }, [detail?.sessionId, detail?.result.pageId]);
  async function openHistory(id: string) {
    try {
      const value = await api<CapabilitySession>(`/capability/sessions/${id}`);
      selectedSession.current = id;
      setSession(value);
      setActiveTurn("");
      setFocused([]);
      setError("");
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  async function start(isFollowup = false, text?: string) {
    const input = (text ?? (isFollowup ? followup : question)).trim();
    if (!input) return;
    if (!isFollowup && !library) {
      message.warning("请先选择知识库");
      return;
    }
    setStarting(true);
    setError("");
    try {
      const value = await post<CapabilitySession>(
        isFollowup && session
          ? `/capability/sessions/${session.id}/turns`
          : "/capability/sessions",
        isFollowup && session
          ? { question: input, focusPaths: focused }
          : {
              question: input,
              wikiProjectId: library,
              scope: { product, version },
              useProjectScope: false,
              focusPaths: [],
            },
      );
      selectedSession.current = value.id;
      setSession(value);
      setActiveTurn("");
      setFocused([]);
      setFollowup("");
      void refreshHistory().catch(() => {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }
  const turn: CapabilityTurn | undefined =
    session?.data.turns.find((t) => t.id === activeTurn) ??
    session?.data.turns.at(-1);
  const results = turn?.results ?? [];
  const selectedLibrary =
    libraries.find((l) => l.id === session?.wiki_project_id)?.name ??
    session?.wiki_project_id;
  async function copy(result: CapabilityResult) {
    const text = [
      `需求：${turn?.question ?? ""}`,
      `候选：${result.product} ${result.version} / ${result.title}`,
      `核验：${labels[result.status].text}（AI辅助核验，交付条件请进一步确认）`,
      ...result.checks.map(
        (c) =>
          `${c.requirement}：${checkLabels[c.status]}；${c.reason}\n${c.evidence.map((e) => `「${e.quote}」 L${e.lineStart}–L${e.lineEnd}`).join("\n")}`,
      ),
      `出处：${result.path}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      message.success("已复制候选、核验说明与出处");
    } catch {
      Modal.info({
        title: "复制检索结果",
        width: 680,
        content: (
          <Input.TextArea
            readOnly
            value={text}
            autoSize={{ minRows: 8, maxRows: 18 }}
          />
        ),
      });
    }
  }
  return (
    <section className={`capability-page ${session ? "has-results" : ""}`}>
      <header className="capability-header">
        <div>
          <span className="capability-eyebrow">PRODUCT CAPABILITIES</span>
          <h1>能力检索</h1>
          <p>输入一句需求，查找哪些产品的哪些销售项可以满足。</p>
        </div>
        <Space wrap>
          {history.length > 0 && (
            <Select
              aria-label="最近检索"
              placeholder="最近检索"
              style={{ width: 220 }}
              value={session?.id}
              options={history.map((h) => ({ value: h.id, label: h.title }))}
              onChange={(id) => void openHistory(id)}
            />
          )}
          <Button
            icon={<PlusOutlined />}
            onClick={() => {
              selectedSession.current = null;
              setSession(null);
              setActiveTurn("");
              setFocused([]);
              setQuestion("");
              setError("");
            }}
          >
            新检索
          </Button>
        </Space>
      </header>
      <div className="capability-search-box">
        <Input.TextArea
          aria-label="描述需要查找的产品能力"
          placeholder="例如：支持跨控制器128门互锁，并能联动视频。"
          value={question}
          maxLength={2000}
          onChange={(e) => setQuestion(e.target.value)}
          autoSize={{ minRows: 2, maxRows: 5 }}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void start();
            }
          }}
        />
        <div className="capability-search-options">
          <Space wrap>
            <Select
              aria-label="选择知识库"
              placeholder="选择知识库"
              value={library || undefined}
              onChange={setLibrary}
              style={{ minWidth: 190 }}
              options={libraries.map((l) => ({ value: l.id, label: l.name }))}
            />
            <Input
              aria-label="产品筛选"
              placeholder="全部产品，或输入产品标识"
              value={product}
              onChange={(e) => setProduct(e.target.value)}
              style={{ width: 220 }}
            />
            <Input
              aria-label="版本筛选"
              placeholder="全部版本"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              style={{ width: 120 }}
            />
          </Space>
          <Button
            type="primary"
            size="large"
            icon={<SearchOutlined />}
            loading={starting}
            disabled={!question.trim() || !!running}
            onClick={() => void start()}
          >
            查找销售项
          </Button>
        </div>
      </div>
      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          closable
          onClose={() => setError("")}
        />
      )}
      {!session && (
        <div className="capability-empty">
          <FileSearchOutlined />
          <h2>这个功能，哪些产品有？</h2>
          <p>可以输入一个模块名称，也可以描述场景、协议或性能条件。</p>
          <div className="capability-examples">
            {[
              "跨控制器多门互锁",
              "报警事件联动广播",
              "支持单点登录与角色权限",
            ].map((q) => (
              <Button key={q} onClick={() => setQuestion(q)}>
                {q}
                <ArrowRightOutlined />
              </Button>
            ))}
          </div>
          <small>命中相关销售项不代表全部满足，关键条件会继续核验。</small>
        </div>
      )}
      {session && (
        <>
          <div className="capability-scope">
            <span>本会话知识库：{selectedLibrary}</span>
            <span>
              {session.data.projectScope.length
                ? session.data.projectScope
                    .map((p) => `${p.name} ${p.version}`)
                    .join("、")
                : session.data.scope.product || "全部产品"}{" "}
              · {session.data.scope.version || "版本分别核验"}
            </span>
          </div>
          <div className="capability-turns">
            {session.data.turns.map((t, i) => (
              <button
                key={t.id}
                className={turn?.id === t.id ? "active" : ""}
                onClick={() => {
                  setActiveTurn(t.id);
                  setFocused([]);
                }}
                title={t.question}
              >
                {i + 1}. {t.question}
              </button>
            ))}
          </div>
          {running && (
            <div className="capability-progress" role="status">
              <Spin size="small" />
              <span>
                {session.data.turns.at(-1)?.phase} · 已找到{" "}
                {session.data.turns.at(-1)?.results.length ?? 0} 个候选
              </span>
              <Button
                size="small"
                icon={<StopOutlined />}
                onClick={() =>
                  void post(
                    `/capability/sessions/${session.id}/cancel`,
                    {},
                  ).catch((e) => message.error(e.message))
                }
              >
                停止
              </Button>
            </div>
          )}
          {pollError && (
            <Alert
              type="warning"
              showIcon
              message={`进度同步中断：${pollError}`}
              description="服务端任务可能仍在运行，正在自动重连。"
            />
          )}
          {turn?.error && (
            <Alert
              type="error"
              showIcon
              message={turn.error}
              action={
                <Button
                  onClick={() => void start(true, turn.question)}
                  disabled={!!running}
                >
                  重试
                </Button>
              }
            />
          )}
          {!!turn?.warnings.length && (
            <Alert
              type="warning"
              showIcon
              message="本次检索有待确认事项"
              description={turn.warnings.join("；")}
            />
          )}
          <div className="capability-results-heading">
            <div>
              <h2>
                {results.length
                  ? `${results.length} 个销售项候选`
                  : running
                    ? "正在寻找相关销售项"
                    : "本次未找到足够依据"}
              </h2>
              <p>{turn?.requirements.join(" · ")}</p>
            </div>
            <small>销售项与产品对应 · 原文可追溯</small>
          </div>
          <div className="capability-results">
            {results.map((result) => (
              <article
                className={`capability-result status-${result.status}`}
                key={result.path}
              >
                <Checkbox
                  aria-label={`选择${result.title}进行追问`}
                  checked={focused.includes(result.path)}
                  disabled={
                    !focused.includes(result.path) && focused.length >= 4
                  }
                  onChange={(e) =>
                    setFocused(
                      e.target.checked
                        ? [...focused, result.path]
                        : focused.filter((p) => p !== result.path),
                    )
                  }
                />
                <div className="capability-result-content">
                  <button
                    className="capability-result-title"
                    onClick={() =>
                      setDetail({
                        result,
                        turnId: turn!.id,
                        sessionId: session.id,
                      })
                    }
                  >
                    <span className="capability-sale-label">销售项</span>
                    {result.title}
                    <ArrowRightOutlined />
                  </button>
                  <div className="capability-product">
                    <span>所属产品</span>
                    <b>
                      {result.productName || result.product || "产品待确认"}
                    </b>
                    <span>{result.version || "版本待确认"}</span>
                    <Tag color={labels[result.status].color}>
                      {labels[result.status].text}
                    </Tag>
                  </div>
                  <div className="capability-result-meta">
                    {result.moduleId || "模块标识待确认"}
                    {result.department && ` · ${result.department}`}
                  </div>
                  <p>
                    {result.checks.length
                      ? result.checks
                          .map(
                            (c) => `${checkLabels[c.status]}：${c.requirement}`,
                          )
                          .join("；")
                      : result.description ||
                        "已找到相关实体，继续核验原文与限制条件。"}
                  </p>
                </div>
                <div className="capability-result-actions">
                  <Button
                    onClick={() =>
                      setDetail({
                        result,
                        turnId: turn!.id,
                        sessionId: session.id,
                      })
                    }
                  >
                    查看证据
                  </Button>
                  <Button
                    type="text"
                    icon={<CopyOutlined />}
                    onClick={() => void copy(result)}
                  >
                    复制
                  </Button>
                </div>
              </article>
            ))}
          </div>
          {!results.length && !running && (
            <Empty description="可以补充场景、使用其他关键词，或新建检索扩大产品范围。" />
          )}
          <div className="capability-followup">
            <label htmlFor="capability-followup">
              继续核实
              {focused.length
                ? ` · 已选 ${focused.length} 个销售项`
                : " · 保留本次需求与产品范围"}
            </label>
            <Input.TextArea
              id="capability-followup"
              value={followup}
              onChange={(e) => setFollowup(e.target.value)}
              placeholder="例如：128门是单机还是跨控制器？还需要购买基础包吗？"
              maxLength={2000}
              autoSize={{ minRows: 2, maxRows: 4 }}
            />
            <Button
              type="primary"
              disabled={!followup.trim() || !!running}
              loading={starting}
              onClick={() => void start(true)}
            >
              继续查验
              <ArrowRightOutlined />
            </Button>
          </div>
        </>
      )}
      <Drawer
        title={detail?.result.title ?? "销售项详情"}
        width={760}
        className="capability-detail"
        open={!!detail}
        onClose={() => setDetail(null)}
      >
        {detail && (
          <>
            <Tag color={labels[detail.result.status].color}>
              {labels[detail.result.status].text}
            </Tag>
            <p className="muted">
              AI 辅助核验结果。报价、集成和交付承诺需结合项目条件确认。
            </p>
            <Descriptions
              column={1}
              size="small"
              bordered
              items={[
                {
                  key: "product",
                  label: "产品 / 版本",
                  children: `${detail.result.product} ${detail.result.version}`,
                },
                {
                  key: "module",
                  label: "模块标识",
                  children: detail.result.moduleId || "未提供",
                },
                {
                  key: "owner",
                  label: "部门 / 负责人",
                  children:
                    [detail.result.department, detail.result.owner]
                      .filter(Boolean)
                      .join(" / ") || "知识库未提供",
                },
                {
                  key: "unit",
                  label: "单位 / 固定价",
                  children: `${detail.result.unit || "单位待确认"} / ${detail.result.price === undefined ? "价格未提供" : detail.result.price}`,
                },
                {
                  key: "quote",
                  label: "报价说明",
                  children: detail.result.quotation || "未提供",
                },
                {
                  key: "deps",
                  label: "依赖",
                  children:
                    detail.result.dependencies.join("、") || "未记录，需确认",
                },
              ]}
            />
            <CapabilityGraph sessionId={detail.sessionId} pageId={detail.result.pageId} />
            <h3>能力核验</h3>
            {detail.result.checks.length ? (
              detail.result.checks.map((c, i) => (
                <section className="capability-check" key={i}>
                  <b>{c.requirement}</b>
                  <Space wrap>
                    <Tag>{checkLabels[c.status]}</Tag>
                    <Tag>{deliveryLabels[c.delivery]}</Tag>
                  </Space>
                  <p>{c.reason}</p>
                  {c.evidence.map((e, j) => (
                    <blockquote key={j}>
                      <KnowledgeMarkdown text={e.quote} />
                      <small>
                        L{e.lineStart}–L{e.lineEnd}
                      </small>
                    </blockquote>
                  ))}
                </section>
              ))
            ) : (
              <Alert
                type="info"
                message="候选尚未完成模型核验，请查看实体原文，或继续追问。"
              />
            )}
            <div className="capability-source-heading">
              <div><h3>销售项原文</h3><small>固定证据快照 · 保留知识库原始内容</small></div>
              <Segmented value={sourceMode} onChange={setSourceMode} options={[
                { value: "read", label: "阅读正文" },
                { value: "raw", label: "原始 Markdown" },
              ]} />
            </div>
            <p className="capability-source-path">{detail.result.path}</p>
            {pageError ? (
              <Alert type="error" message={pageError} />
            ) : page ? (
              <>
                {sourceMode === "read" ? (
                  <article className="knowledge-markdown capability-document">
                    <KnowledgeMarkdown text={page.content} />
                  </article>
                ) : <pre className="capability-raw-source">{page.content}</pre>}
                <small className="muted">
                  内容版本：{page.hash.slice(0, 16)}
                </small>
              </>
            ) : (
              <Spin />
            )}
          </>
        )}
      </Drawer>
    </section>
  );
}
