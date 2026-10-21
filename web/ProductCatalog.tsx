import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Empty,
  Input,
  Modal,
  Pagination,
  Select,
  Spin,
  Tag,
} from "antd";
import type {
  KnowledgeBrowse,
  KnowledgeDependency,
  KnowledgeSale,
} from "../shared/product-knowledge";
import { api } from "./api";
import { KnowledgeMarkdown } from "./KnowledgeReader";
import "./ProductCatalog.css";

function price(
  item: Pick<KnowledgeSale, "fixed_price" | "currency" | "price_type">,
) {
  if (
    item.fixed_price === null ||
    item.fixed_price === "" ||
    item.fixed_price === undefined
  )
    return "价格未知";
  const amount = String(item.fixed_price)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
  return `${amount} ${item.currency || ""}`.trim();
}

export function ProductCatalog({
  projectId,
  product,
}: {
  projectId: string;
  product: { name: string; version: string; path?: string; productId?: string };
}) {
  const [version, setVersion] = useState("");
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<KnowledgeBrowse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    item: KnowledgeSale;
    dependencies: KnowledgeDependency[];
  } | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailAttempt, setDetailAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setData(null);
    setSelected(null);
    const params = new URLSearchParams({
      name: product.name,
      version: version || product.version,
      path: product.path || "",
      offset: String(offset),
      limit: "12",
    });
    if (product.productId) params.set("productId", product.productId);
    if (category) params.set("categoryId", category);
    if (query.trim()) params.set("q", query.trim());
    void api<KnowledgeBrowse>(
      `/projects/${projectId}/knowledge/catalog?${params}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    projectId,
    product.name,
    product.version,
    product.path,
    product.productId,
    version,
    category,
    query,
    offset,
    attempt,
  ]);
  useEffect(() => {
    if (!selected || !data?.releaseId) return;
    const controller = new AbortController();
    setDetail(null);
    setDetailError("");
    void api<{ item: KnowledgeSale; dependencies: KnowledgeDependency[] }>(
      `/projects/${projectId}/knowledge/items/${encodeURIComponent(selected)}?releaseId=${encodeURIComponent(data.releaseId)}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setDetail(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setDetailError(e.message);
      });
    return () => controller.abort();
  }, [selected, data?.releaseId, projectId, detailAttempt]);
  return (
    <section className="product-catalog" aria-label="产品销售项目录">
      <div className="catalog-heading">
        <div>
          <h4>销售项目录</h4>
          <span className="muted">
            {data?.releaseName || "已发布结构化知识"}
          </span>
        </div>
        <Select
          aria-label="浏览产品版本"
          value={version || product.version || undefined}
          placeholder="产品版本"
          disabled={loading || !data?.versions.length}
          options={data?.versions.map((v) => ({
            value: v.version,
            label: v.version,
          }))}
          onChange={(value) => {
            setVersion(value);
            setCategory("");
            setOffset(0);
          }}
        />
      </div>
      <p className="catalog-hint">
        切换版本仅用于浏览；产品勾选与已确认范围保持不变。
      </p>
      <Input.Search
        aria-label="搜索销售项名称或编码"
        placeholder="搜索销售项名称或编码"
        allowClear
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOffset(0);
        }}
      />
      {error ? (
        <Alert
          type="error"
          showIcon
          message="目录加载失败"
          description={error}
          action={
            <Button onClick={() => setAttempt((n) => n + 1)}>重试</Button>
          }
        />
      ) : loading ? (
        <div className="catalog-loading">
          <Spin tip="加载销售项目录" />
        </div>
      ) : !data?.releaseId ? (
        <Empty description="尚未发布结构化目录，请联系管理员导入并发布知识版本。" />
      ) : !data.product ? (
        <Empty description="当前发布版本中未找到该产品目录。" />
      ) : (
        <>
          <div className="catalog-layout">
            <nav className="catalog-categories" aria-label="销售项分类">
              <button
                type="button"
                className={!category ? "active" : ""}
                onClick={() => {
                  setCategory("");
                  setOffset(0);
                }}
              >
                全部分类
              </button>
              {data.categories.map((c) => (
                <button
                  type="button"
                  key={c.category_id}
                  className={category === c.category_id ? "active" : ""}
                  onClick={() => {
                    setCategory(c.category_id);
                    setOffset(0);
                  }}
                >
                  <span>{c.name}</span>
                  <span>{c.count}</span>
                </button>
              ))}
            </nav>
            <div className="catalog-items">
              <div className="catalog-list-heading">
                <span>销售项 / 编码</span>
                <span>单位 · 价格</span>
              </div>
              {data.items.length ? (
                data.items.map((item) => (
                  <button
                    type="button"
                    key={item.sale_item_id}
                    className="catalog-item"
                    onClick={() => {
                      setDetail(null);
                      setDetailError("");
                      setSelected(item.sale_item_id);
                    }}
                  >
                    <span>
                      <strong>{item.name}</strong>
                      <small>
                        {item.module_code || "编码未提供"}
                        {item.mandatory === true && (
                          <Tag color="blue">必选</Tag>
                        )}
                      </small>
                    </span>
                    <span className="catalog-item-price">
                      <span>{item.unit || "单位未知"}</span>
                      <small>{price(item)}</small>
                    </span>
                  </button>
                ))
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    query ? "没有匹配的销售项" : "当前分类暂无销售项"
                  }
                />
              )}
            </div>
          </div>
          <Pagination
            size="small"
            current={Math.floor(offset / 12) + 1}
            pageSize={12}
            total={data.total}
            showSizeChanger={false}
            hideOnSinglePage
            onChange={(page) => setOffset((page - 1) * 12)}
            showTotal={(total) => `共 ${total} 项`}
          />
        </>
      )}
      <Modal
        title={detail?.item.name || "销售项详情"}
        open={!!selected}
        onCancel={() => setSelected(null)}
        footer={<Button onClick={() => setSelected(null)}>关闭</Button>}
        width={760}
        className="catalog-detail-modal"
      >
        {detailError ? (
          <Alert
            type="error"
            message={detailError}
            action={
              <Button onClick={() => setDetailAttempt((n) => n + 1)}>
                重试
              </Button>
            }
          />
        ) : !detail ? (
          <div className="catalog-loading">
            <Spin />
          </div>
        ) : (
          <div className="catalog-sale-detail">
            <div className="catalog-sale-meta">
              <Tag>{detail.item.module_code || "编码未提供"}</Tag>
              <Tag>{detail.item.unit || "单位未知"}</Tag>
              <Tag>{price(detail.item)}</Tag>
              {detail.item.mandatory !== null && (
                <Tag>{detail.item.mandatory ? "必选" : "可选"}</Tag>
              )}
            </div>
            {detail.item.pricing_note && (
              <p className="muted">{detail.item.pricing_note}</p>
            )}
            <section>
              <h4>规格说明</h4>
              <KnowledgeMarkdown
                text={
                  detail.item.specification_md ||
                  detail.item.description ||
                  "暂无规格说明"
                }
              />
            </section>
            {[
              ["授权说明", detail.item.authorization_note],
              ["前提条件", detail.item.prerequisites],
              ["限制条件", detail.item.limitations],
              ["依赖说明", detail.item.dependency_note],
            ].map(([title, content]) => (
              <section key={title}>
                <h4>{title}</h4>
                {content ? (
                  <KnowledgeMarkdown text={content} />
                ) : (
                  <p className="muted">未提供</p>
                )}
              </section>
            ))}
            {!!detail.dependencies.length && (
              <section>
                <h4>依赖销售项</h4>
                {detail.dependencies.map((d) => (
                  <div className="catalog-dependency" key={d.dependency_id}>
                    <Tag>{d.dependency_type}</Tag>
                    <code>{d.depends_on_sale_item_id}</code>
                    <KnowledgeMarkdown
                      text={
                        d.condition_note || d.source_note || "未提供依赖条件"
                      }
                    />
                  </div>
                ))}
              </section>
            )}
          </div>
        )}
      </Modal>
    </section>
  );
}
