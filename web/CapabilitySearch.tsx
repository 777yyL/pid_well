import { useEffect, useRef, useState } from "react";
import {
  App,
  Alert,
  Button,
  Drawer,
  Empty,
  Input,
  Modal,
  Segmented,
  Select,
  Skeleton,
} from "antd";
import {
  ArrowRightOutlined,
  CopyOutlined,
  FileSearchOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { api } from "./api";
import { KnowledgeMarkdown } from "./KnowledgeReader";
import { WikiGraph } from "./WikiGraph";
import type {
  QuickSearchResponse,
  QuickSearchResult,
} from "../shared/quick-search";

export function CapabilitySearch() {
  const { message } = App.useApp();
  const [libraries, setLibraries] = useState<{ id: string; name: string }[]>(
    [],
  );
  const [library, setLibrary] = useState("");
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [response, setResponse] = useState<
    (QuickSearchResponse & { wikiProjectId: string }) | null
  >(null);
  const [detail, setDetail] = useState<QuickSearchResult | null>(null);
  const [graph, setGraph] = useState<QuickSearchResult | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState("");
  const [sourceMode, setSourceMode] = useState("read");
  const [retry, setRetry] = useState(0);
  const searchRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ projects: { id: string; name: string }[] }>("/wiki/projects", {
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        const list = Array.isArray(value.projects) ? value.projects : [];
        setLibraries(list);
        setLibrary(list[0]?.id || "");
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(`知识库列表读取失败：${e.message}`);
      });
    return () => {
      controller.abort();
      searchRequest.current?.abort();
    };
  }, []);
  useEffect(() => {
    setSource(null);
    setSourceError("");
    setSourceMode("read");
    if (!detail || !response) return;
    const controller = new AbortController();
    void api<{ content: string }>("/capability/source", {
      method: "POST",
      body: JSON.stringify({
        wikiProjectId: response.wikiProjectId,
        path: detail.path,
      }),
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setSource(value.content);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setSourceError(e.message);
      });
    return () => controller.abort();
  }, [detail, response?.wikiProjectId, retry]);
  async function search() {
    if (!question.trim() || !library) return;
    searchRequest.current?.abort();
    const controller = new AbortController();
    searchRequest.current = controller;
    setLoading(true);
    setGraph(null);
    setError("");
    setResponse(null);
    setDetail(null);
    const wikiProjectId = library;
    try {
      const value = await api<QuickSearchResponse>("/capability/search", {
        method: "POST",
        body: JSON.stringify({ wikiProjectId, query: question.trim() }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setResponse({ ...value, wikiProjectId });
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  async function copy(result: QuickSearchResult) {
    const text = `销售项：${result.title}\n所属产品：${result.product || "知识库未提供"} ${result.version}\n模块标识：${result.moduleId || "未提供"}\n${result.summary}\n来源：${result.path}`;
    try {
      await navigator.clipboard.writeText(text);
      message.success("已复制销售项与产品信息");
    } catch {
      Modal.info({
        title: "复制检索结果",
        width: 640,
        content: (
          <Input.TextArea
            readOnly
            value={text}
            autoSize={{ minRows: 6, maxRows: 16 }}
          />
        ),
      });
    }
  }
  return (
    <section className="capability-page">
      <header className="capability-header">
        <div>
          <span className="capability-eyebrow">PRODUCT CAPABILITIES</span>
          <h1>能力检索</h1>
          <p>输入功能描述，快速查找对应销售项与所属产品。</p>
        </div>
        <span className="capability-quick-label">LLM Wiki 直接检索</span>
      </header>
      <div className="capability-search-box">
        <Input.TextArea
          aria-label="描述需要查找的产品能力"
          placeholder="例如：访客预约、跨控制器多门互锁、报警联动广播"
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
              void search();
            }
          }}
        />
        <div className="capability-search-options">
          <Select
            aria-label="选择知识库"
            placeholder="选择知识库"
            value={library || undefined}
            onChange={(value) => {
              searchRequest.current?.abort();
              setLoading(false);
              setLibrary(value);
              setDetail(null);
              setGraph(null);
              setResponse(null);
              setError("");
            }}
            style={{ minWidth: 210 }}
            options={libraries.map((l) => ({ value: l.id, label: l.name }))}
          />
          <Button
            type="primary"
            size="large"
            icon={<SearchOutlined />}
            loading={loading}
            disabled={!question.trim() || !library}
            onClick={() => void search()}
          >
            查找销售项
          </Button>
        </div>
      </div>
      {error && (
        <Alert
          style={{ marginTop: 16 }}
          type="error"
          showIcon
          message="检索失败"
          description={error}
          action={
            <Button onClick={() => void search()} disabled={loading}>
              重试
            </Button>
          }
        />
      )}
      {loading ? (
        <div className="capability-quick-loading">
          <p>正在检索知识库…</p>
          <Skeleton active paragraph={{ rows: 4 }} />
        </div>
      ) : response ? (
        <>
          <div className="capability-results-heading">
            <div>
              <h2>{response.results.length} 个销售项</h2>
              <p>
                “{response.query}” ·{" "}
                {libraries.find((l) => l.id === response.wikiProjectId)?.name}
              </p>
            </div>
            <small>
              接口耗时 {(response.elapsedMs / 1000).toFixed(2)} 秒 ·
              按知识库返回顺序
            </small>
          </div>
          <div className="capability-results">
            {response.results.map((result) => (
              <article className="capability-result" key={result.path}>
                <div className="capability-result-content">
                  <button
                    className="capability-result-title"
                    onClick={() => setDetail(result)}
                  >
                    <span className="capability-sale-label">销售项</span>
                    {result.title}
                    <ArrowRightOutlined />
                  </button>
                  <div className="capability-product">
                    <span>所属产品</span>
                    <b>{result.product || "知识库未提供"}</b>
                    {result.version && <span>{result.version}</span>}
                  </div>
                  {result.moduleId && (
                    <div className="capability-result-meta">
                      {result.moduleId}
                    </div>
                  )}
                  {result.summary && <p>{result.summary}</p>}
                </div>
                <div className="capability-result-actions">
                  <Button onClick={() => setDetail(result)}>查看原文</Button>
                  <Button onClick={() => setGraph(result)}>查看图谱</Button>
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
          {!response.results.length && (
            <Empty description="未检索到销售项，请尝试更简短的功能关键词。" />
          )}
          <p className="capability-graph-help">
            结果来自知识库检索，表示内容相关，具体满足情况请查看原文。
          </p>
        </>
      ) : (
        !error && (
          <div className="capability-empty">
            <FileSearchOutlined />
            <h2>这个功能，哪些产品有？</h2>
            <p>直接检索知识库，找到销售项与产品。点击结果再查看原文。</p>
            <div className="capability-examples">
              {["访客管理", "多门互锁", "报警联动广播"].map((q) => (
                <Button key={q} onClick={() => setQuestion(q)}>
                  {q}
                  <ArrowRightOutlined />
                </Button>
              ))}
            </div>
          </div>
        )
      )}
      {graph && response && <WikiGraph key={`${response.wikiProjectId}:${graph.path}`} wikiProjectId={response.wikiProjectId} path={graph.path} title={graph.title} onClose={() => setGraph(null)} />}
      <Drawer
        title={detail?.title || "销售项原文"}
        width={760}
        className="capability-detail"
        open={!!detail}
        onClose={() => setDetail(null)}
      >
        {detail && (
          <>
            <div className="capability-product">
              <span>所属产品</span>
              <b>{detail.product || "知识库未提供"}</b>
              <span>{detail.version}</span>
            </div>
            <p className="capability-source-path">{detail.path}</p>
            <div className="capability-source-heading">
              <div>
                <h3>销售项原文</h3>
                <small>当前知识库内容</small>
              </div>
              <Segmented
                value={sourceMode}
                onChange={setSourceMode}
                options={[
                  { value: "read", label: "阅读正文" },
                  { value: "raw", label: "原始 Markdown" },
                ]}
              />
            </div>
            {sourceError ? (
              <Alert
                type="error"
                message="原文读取失败"
                description={sourceError}
                action={
                  <Button onClick={() => setRetry((v) => v + 1)}>重试</Button>
                }
              />
            ) : source === null ? (
              <Skeleton active paragraph={{ rows: 8 }} />
            ) : sourceMode === "read" ? (
              <article
                className="knowledge-markdown capability-document"
                style={{ marginTop: 16 }}
              >
                <KnowledgeMarkdown text={source} />
              </article>
            ) : (
              <pre className="capability-raw-source">{source}</pre>
            )}
          </>
        )}
      </Drawer>
    </section>
  );
}
