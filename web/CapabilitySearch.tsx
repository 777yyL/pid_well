import { useEffect, useRef, useState } from "react";
import {
  App,
  Alert,
  Button,
  Drawer,
  Empty,
  Input,
  InputNumber,
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
  const libraries = [{ id: "pg", name: "产品销售项知识库" }];
  const library = "pg";
  const [mode, setMode] = useState<"keyword" | "vector" | "hybrid">("keyword");
  const [topK, setTopK] = useState(10);
  const [minSimilarity, setMinSimilarity] = useState<number | undefined>();
  const [embeddingEnabled, setEmbeddingEnabled] = useState(false);
  const [products, setProducts] = useState<
    { product_id: string; product_code: string }[]
  >([]);
  const [versions, setVersions] = useState<
    { product_version_id: string; product_id: string; version: string }[]
  >([]);
  const [productIds, setProductIds] = useState<string[]>([]);
  const [versionIds, setVersionIds] = useState<string[]>([]);
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
    void Promise.all([
      api<{ products: typeof products; versions: typeof versions }>(
        "/knowledge/products",
        { signal: controller.signal },
      ),
      api<{
        enabled: boolean;
        mode: typeof mode;
        topK: number;
        minSimilarity?: number;
      }>("/knowledge/retrieval-options", { signal: controller.signal }),
    ])
      .then(([data, options]) => {
        if (controller.signal.aborted) return;
        setProducts(data.products);
        setVersions(data.versions);
        setMode(options.mode);
        setTopK(options.topK);
        setMinSimilarity(options.minSimilarity);
        setEmbeddingEnabled(options.enabled);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
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
        body: JSON.stringify({
          query: question.trim(),
          mode,
          topK,
          minSimilarity: minSimilarity ?? null,
          productIds,
          versionIds,
        }),
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
          <h1>能力检索</h1>
          <p>输入功能描述，快速查找对应销售项与所属产品。</p>
        </div>
        <span className="capability-quick-label">PG 产品知识检索</span>
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
            aria-label="检索模式"
            value={mode}
            onChange={setMode}
            style={{ width: 150 }}
            options={[
              { value: "keyword", label: "关键词检索" },
              {
                value: "vector",
                label: "向量检索",
                disabled: !embeddingEnabled,
              },
              {
                value: "hybrid",
                label: "混合检索",
                disabled: !embeddingEnabled,
              },
            ]}
          />
          <Select
            aria-label="限定产品"
            mode="multiple"
            placeholder="全部产品"
            value={productIds}
            style={{ minWidth: 190, maxWidth: 320 }}
            options={products.map((p) => ({
              value: p.product_id,
              label: p.product_code,
            }))}
            onChange={(ids) => {
              setProductIds(ids);
              setVersionIds([]);
            }}
          />
          <Select
            aria-label="限定版本"
            mode="multiple"
            placeholder="全部版本"
            value={versionIds}
            style={{ minWidth: 180, maxWidth: 320 }}
            options={versions
              .filter(
                (v) => !productIds.length || productIds.includes(v.product_id),
              )
              .map((v) => ({
                value: v.product_version_id,
                label:
                  (products.find((p) => p.product_id === v.product_id)
                    ?.product_code ?? "") +
                  " · " +
                  v.version,
              }))}
            onChange={setVersionIds}
          />
          <label>
            topK{" "}
            <InputNumber
              aria-label="返回数量 topK"
              min={1}
              max={100}
              value={topK}
              onChange={(n) => setTopK(n ?? 10)}
            />
          </label>
          {mode !== "keyword" && (
            <label>
              相似度 ≥{" "}
              <InputNumber
                aria-label="最低余弦相似度"
                min={-1}
                max={1}
                step={0.05}
                value={minSimilarity}
                placeholder="不限"
                onChange={(n) => setMinSimilarity(n ?? undefined)}
              />
            </label>
          )}
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
              {response.mode === "keyword"
                ? "关键词排序"
                : response.mode === "vector"
                  ? "向量排序"
                  : "混合排序"}
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
                  <small className="muted">
                    {result.category} · 关键词得分 {result.keywordScore ?? 0}
                    {result.vectorSimilarity != null
                      ? ` · 余弦相似度 ${result.vectorSimilarity.toFixed(3)}`
                      : ""}{" "}
                    · 相关性不代表满足程度
                  </small>
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
      {graph && response && (
        <WikiGraph
          key={`${response.wikiProjectId}:${graph.path}`}
          wikiProjectId={response.wikiProjectId}
          path={graph.path}
          title={graph.title}
          onClose={() => setGraph(null)}
        />
      )}
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
