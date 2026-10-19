import { coverageLabel } from "../shared/accuracy";
import { useEffect, useState } from "react";
import { KnowledgeMarkdown } from "./KnowledgeReader";
import {
  Alert,
  Button,
  Collapse,
  Empty,
  Input,
  Pagination,
  Select,
  Spin,
  Tag,
} from "antd";
import {
  DownloadOutlined,
  CompassOutlined,
  LockOutlined,
} from "@ant-design/icons";
import type { SharedResult as Result, SharedAssessment } from "../shared/share";
import { api } from "./api";
const levels = {
  exact: { label: "完全满足", color: "success" },
  partial: { label: "部分满足", color: "warning" },
  no_match: { label: "不满足", color: "error" },
  unknown: { label: "待确认", color: "processing" },
};
const criteriaNames: Record<string, string> = {
  direction: "能力方向",
  scope: "能力边界",
  spec: "规格参数",
  context: "场景适配",
  delivery: "交付约束",
};
function Detail({ row }: { row: SharedAssessment }) {
  return (
    <div className="shared-detail">
      <h3>招标原文</h3>
      <blockquote className="shared-source">{row.requirement_raw}</blockquote>
      <p>
        <b>
          {row.product} {row.version}
        </b>{" "}
        · {row.sales.join("、") || "未找到对应销售项"}
      </p>
      <h3>结论说明</h3>
      <p>{row.note}</p>
      <h3>子要求、组合与风险核验</h3>
      <p style={{ whiteSpace: "pre-wrap" }}>
        {row.accuracySummary || "历史结果：未按新版逐子要求核验"}
      </p>
      <div className="shared-findings">
        {(["ok", "hard", "no"] as const).map((key) => (
          <section className={`assessment-finding ${key}`} key={key}>
            <h4>
              {{ ok: "已具备", hard: "需配置 / 定制", no: "明确缺口" }[key]}
            </h4>
            {row[key].length ? (
              <ul>
                {row[key].map((text, i) => (
                  <li key={i}>{text}</li>
                ))}
              </ul>
            ) : (
              <span>未记录</span>
            )}
          </section>
        ))}
      </div>
      <h3>五项判断依据</h3>
      <dl>
        {Object.entries(row.criteria).map(([key, value]) => (
          <div key={key}>
            <dt>{criteriaNames[key] ?? key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <h3>知识库原始证据</h3>
      {row.evidence.length ? (
        row.evidence.map((proof, i) => (
          <div className="evidence-card" key={i}>
            <blockquote>{proof.quote}</blockquote>
            <small>
              {proof.path} · L{proof.lineStart}–L{proof.lineEnd}
            </small>
          </div>
        ))
      ) : (
        <p className="muted">未记录对应产品证据</p>
      )}
      <p className="muted">
        交付依赖：{row.dependencies.join("、") || "未列出"} · 必选项：
        {row.mustSelect.join("、") || "未列出"} ·{" "}
        {row.source === "human" ? "人工确认" : "AI 自检完成"} · 结果版本{" "}
        {row.revision}
      </p>
    </div>
  );
}
export function SharedResult({ token }: { token: string }) {
  const [result, setResult] = useState<Result | null>(null),
    [error, setError] = useState("");
  const [filter, setFilter] = useState("all"),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(1);
  const [tab, setTab] = useState("assessments");
  useEffect(() => {
    let live = true;
    setResult(null);
    setError("");
    void api<Result>(`/shared/${token}`, { credentials: "omit" })
      .then((data) => {
        if (live) setResult(data);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [token]);
  if (error)
    return (
      <main className="shared-result shared-error">
        <LockOutlined />
        <h1>暂时无法打开分享成果</h1>
        <Alert type="warning" showIcon message={error} />
        <p>链接可能已到期或被撤销，请联系分享人获取新的链接。</p>
        <Button onClick={() => window.location.reload()}>重新连接</Button>
      </main>
    );
  if (!result)
    return (
      <main className="loading-screen">
        <Spin size="large" tip="读取分享成果" />
      </main>
    );
  const filtered = result.rows.filter(
    (row) =>
      (filter === "all" || row.level === filter) &&
      (!search ||
        [
          row.requirementId,
          row.requirement_raw,
          row.product,
          row.sales.join("、"),
          row.note,
        ]
          .join(" ")
          .toLowerCase()
          .includes(search.toLowerCase())),
  );
  const download = (id: string) => `/api/shared/${token}/artifacts/${id}`;
  return (
    <main className="shared-result">
      <div className="shared-brand">
        <CompassOutlined />
        <b>评标AI</b>
        <span>售前评估成果</span>
        <span className="shared-readonly">
          <LockOutlined /> 只读分享 · 无需登录
        </span>
      </div>
      <header className="shared-cover">
        <div>
          <span>评估结果已固定</span>
          <h1>{result.projectName}</h1>
          <p>
            生成：{new Date(result.generatedAt).toLocaleString("zh-CN")} ·
            分享有效至 {new Date(result.expiresAt).toLocaleString("zh-CN")}
          </p>
        </div>
        <div className="shared-downloads">
          {result.files.map((file) => (
            <Button
              type={
                file.kind === "full" && file.format === "xlsx"
                  ? "primary"
                  : "default"
              }
              key={file.id}
              href={download(file.id)}
              icon={<DownloadOutlined />}
            >
              {file.kind === "sales"
                ? "下载销售项清单"
                : file.format === "xlsx"
                  ? "下载评估报告"
                  : "下载网页版报告"}
            </Button>
          ))}
        </div>
      </header>
      <section className="shared-stats">
        <div>
          <span>技术条款 / 销售项</span>
          <b>
            {result.rows.length} / {result.sales.length}
          </b>
        </div>
        {Object.entries(levels).map(([level, { label }]) => (
          <div className={level} key={level}>
            <span>{label}</span>
            <b>{result.rows.filter((row) => row.level === level).length}</b>
          </div>
        ))}
      </section>
      <p className="shared-meta">
        处理完成；AI
        自检与人工确认见逐条来源。此链接固定分享时结果；数量与授权范围待核定。
        原文覆盖：
        {result.sourceCoverage
          ?.map(
            (d) =>
              `${d.name} ${coverageLabel(d.status)}，未检查 ${d.uncheckedLines.length} 行`,
          )
          .join("；") || "待检查"}
        。未知项不计为满足。
      </p>
      {!!result.procurementIssues?.length && (
        <section className="shared-strategy">
          <h2>采购清单待核实</h2>
          <p>当前销售项为参考清单，尚不能作为最终采购或报价依据。</p>
          <ul>
            {result.procurementIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </section>
      )}
      {!!result.componentReuse?.length && (
        <section className="shared-strategy">
          <h2>组件复用记录</h2>
          <ul>
            {result.componentReuse.map((r, i) => (
              <li key={i}>
                {r.requirementId} · {r.product} {r.version} / {r.sales} →{" "}
                {r.source}；{r.reason}
              </li>
            ))}
          </ul>
        </section>
      )}
      {result.strategy && (
        <section className="shared-strategy">
          <h2>售前选型策略</h2>
          <p>{result.strategy}</p>
        </section>
      )}
      <nav className="shared-tabs">
        <Button
          type={tab === "assessments" ? "primary" : "default"}
          onClick={() => setTab("assessments")}
        >
          逐条评估与证据
        </Button>
        <Button
          type={tab === "sales" ? "primary" : "default"}
          onClick={() => setTab("sales")}
        >
          销售项清单 · {result.sales.length} 项
        </Button>
      </nav>
      {tab === "assessments" ? (
        <section>
          <div className="shared-filters">
            <Input.Search
              placeholder="搜索条款、产品或销售项"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              allowClear
            />
            <Select
              value={filter}
              onChange={(value) => {
                setFilter(value);
                setPage(1);
              }}
              options={[
                { value: "all", label: "全部结论" },
                ...Object.entries(levels).map(([value, { label }]) => ({
                  value,
                  label,
                })),
              ]}
            />
          </div>
          {filtered.length ? (
            <Collapse
              className="shared-assessments"
              items={filtered.slice((page - 1) * 10, page * 10).map((row) => ({
                key: row.requirementId,
                className: `shared-row ${row.level}`,
                label: (
                  <div className="shared-row-title">
                    <span>
                      <b>
                        {row.requirementId} · {row.module}
                      </b>
                      <p>{row.requirement_raw}</p>
                      <small>
                        {row.sales.join("、") || "未找到对应销售项"}
                      </small>
                    </span>
                    <Tag color={levels[row.level].color}>
                      {levels[row.level].label}
                    </Tag>
                  </div>
                ),
                children: <Detail row={row} />,
              }))}
            />
          ) : (
            <Empty description="没有符合条件的条款" />
          )}
          <Pagination
            current={page}
            pageSize={10}
            total={filtered.length}
            onChange={setPage}
            showSizeChanger={false}
            showTotal={(total) => `共 ${total} 条`}
          />
        </section>
      ) : (
        <section className="shared-sales shared-sales-list">
          {result.sales.length ? (
            Array.from(
              new Map(
                result.sales.map((sale) => [
                  JSON.stringify([sale.product, sale.version]),
                  { product: sale.product, version: sale.version },
                ]),
              ).values(),
            ).map((group) => {
              const sales = result.sales.filter(
                (sale) =>
                  sale.product === group.product &&
                  sale.version === group.version,
              );
              return (
                <section
                  className="shared-product-group"
                  key={JSON.stringify([group.product, group.version])}
                >
                  <header className="shared-product-heading">
                    <div>
                      <h2>{group.product || "未标明产品"}</h2>
                      {group.version && <Tag>{group.version}</Tag>}
                    </div>
                    <span>{sales.length} 项销售项</span>
                  </header>
                  <div className="shared-sales-columns" aria-hidden="true">
                    <span>销售项 / 型号</span>
                    <span>单价 / 单位</span>
                    <span>数量</span>
                    <span>合价</span>
                    <span>详情</span>
                  </div>
                  {sales.map((sale, index) => (
                    <details
                      className="shared-sale-row"
                      key={`${sale.moduleId}-${index}`}
                    >
                      <summary>
                        <span className="shared-sale-name">
                          <b>{sale.title}</b>
                          <small>{sale.moduleId || "型号未提供"}</small>
                        </span>
                        <span className="shared-sale-price">
                          <small className="sale-mobile-label">单价</small>
                          {sale.price ?? "未提供"}
                          <small>{sale.unit ? ` / ${sale.unit}` : ""}</small>
                        </span>
                        <span>
                          <small className="sale-mobile-label">数量</small>
                          {sale.quantity ?? "待核定"}
                        </span>
                        <span>
                          <small className="sale-mobile-label">合价</small>
                          {sale.total ??
                            (sale.quantity !== undefined &&
                            sale.price !== undefined
                              ? sale.quantity * sale.price
                              : "待核定")}
                        </span>
                        <span className="sale-expand-label">展开</span>
                      </summary>
                      <div className="shared-sale-body knowledge-markdown">
                        <p className="shared-sale-context">
                          产品类别：{sale.category || "未提供"} · 关联条款：
                          {sale.requirements.join("、") || "未提供"}
                        </p>
                        <h3>技术规格</h3>
                        <KnowledgeMarkdown
                          text={sale.specification || "知识库未提供"}
                        />
                        <h3>报价与交付说明</h3>
                        <KnowledgeMarkdown
                          text={
                            [
                              sale.description,
                              sale.quotation,
                              sale.dependencyNote &&
                                `依赖：${sale.dependencyNote}`,
                              sale.mandatory && `必选：${sale.mandatory}`,
                            ]
                              .filter(Boolean)
                              .join("\n\n") || "知识库未提供"
                          }
                        />
                      </div>
                    </details>
                  ))}
                </section>
              );
            })
          ) : (
            <Empty description="没有匹配销售项" />
          )}
        </section>
      )}
      <footer className="shared-footer">
        仅供项目成果查阅与内部协作。投标响应需结合原文、产品证据及交付约束核验。
      </footer>
    </main>
  );
}
