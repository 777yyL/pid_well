import { useEffect, useState, useRef } from "react";
import {
  Alert,
  Modal,
  App as AntApp,
  Button,
  Checkbox,
  Form,
  Input,
  Space,
  Tag,
} from "antd";
import type { ProductScope, ProductAlternative } from "../shared/domain";
import { api } from "./api";
import { KnowledgeMarkdown } from "./KnowledgeReader";
import { AppstoreOutlined } from "@ant-design/icons";
import { ProductCatalog } from "./ProductCatalog";
const key = (p: { name: string; version: string }) =>
  JSON.stringify([p.name, p.version]);
function ProductBasics({
  product,
  compact = false,
}: {
  product: ProductScope["recommendations"][number];
  compact?: boolean;
}) {
  return (
    <dl className={`product-basic-info ${compact ? "compact" : ""}`}>
      {!compact && (
        <div>
          <dt>产品标识</dt>
          <dd className="product-identifier">
            {product.productId || "未提供"}
          </dd>
        </div>
      )}
      <div>
        <dt>产品线</dt>
        <dd>{product.productLine || "未提供"}</dd>
      </div>
      <div>
        <dt>产品部门</dt>
        <dd>{product.department || "未提供"}</dd>
      </div>
      <div>
        <dt>负责人</dt>
        <dd>{product.owner || "未提供"}</dd>
      </div>
    </dl>
  );
}
export function ProductSelection({
  projectId,
  scope,
  alternatives,
  locked,
  active,
  onRefresh,
  onSend,
}: {
  projectId: string;
  scope: ProductScope;
  alternatives: ProductAlternative[];
  locked: boolean;
  active: boolean;
  onRefresh: () => Promise<void>;
  onSend: (text: string) => Promise<void>;
}) {
  const [form] = Form.useForm();
  const autoPlanRequests = useRef(new Set<string>());
  const [refreshingInfo, setRefreshingInfo] = useState(false);
  const combinations = scope.combinations ?? [];
  function chooseProducts(products: { name: string; version: string }[]) {
    if (!canChoose) return;
    form.setFieldValue("choices", products.map(key));
    message.success(
      `已选中 ${products.length} 个推荐产品，可调整后确认范围；自定义产品保留`,
    );
  }
  const selectedProducts: string[] = Form.useWatch("choices", form) ?? [];
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const detail = scope.recommendations.find((p) => key(p) === detailKey);
  const [busy, setBusy] = useState(false);
  const canChoose = !locked && !active && !busy;
  const { message, modal } = AntApp.useApp();
  useEffect(() => {
    const recommended = new Set(scope.recommendations.map(key));
    const draft = form.getFieldsValue();
    form.setFieldsValue({
      choices: scope.selected.filter((p) => recommended.has(key(p))).map(key),
      custom:
        scope.status === "pending"
          ? (draft.custom ?? [])
          : scope.selected.filter((p) => !recommended.has(key(p))),
      strategy:
        scope.status === "pending"
          ? scope.strategy || draft.strategy || ""
          : scope.strategy,
    });
  }, [projectId, scope.revision, form]);
  async function generatePlans() {
    setBusy(true);
    try {
      await onSend(
        "请 project_context 读取现有候选产品、策略和 revision，必要时 wiki_overview 读取总览核实。使用 recommend_product_plans 生成1–3套选型建议，明确每套建议选哪些产品、各产品分工和方案理由。互为替代的产品分别给方案，不要默认把所有候选组合。保留已有候选、基本信息及已确认范围，不要再次 recommend_products。完成后等待用户采用方案。",
      );
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const requestKey = projectId + ":" + scope.revision;
    if (
      scope.recommendations.length &&
      !combinations.length &&
      !active &&
      !busy &&
      scope.status !== "legacy" &&
      !autoPlanRequests.current.has(requestKey)
    ) {
      autoPlanRequests.current.add(requestKey);
      void generatePlans();
    }
  }, [
    projectId,
    scope.revision,
    scope.status,
    scope.recommendations.length,
    combinations.length,
    active,
    busy,
  ]);
  async function refreshProductInfo() {
    setRefreshingInfo(true);
    try {
      await api(`/projects/${projectId}/product-info/refresh`, {
        method: "POST",
      });
      await onRefresh();
      message.success("产品基本信息已按最新总览更新");
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setRefreshingInfo(false);
    }
  }
  async function addAlternative(p: ProductAlternative["data"]["product"]) {
    setBusy(true);
    try {
      await api(`/projects/${projectId}/product-scope`, {
        method: "PUT",
        body: JSON.stringify({
          expectedRevision: scope.revision,
          selected: [...scope.selected, p],
          strategy: scope.strategy,
        }),
      });
      await onRefresh();
      message.success(
        "已加入匹配范围，请继续评估以核实正式匹配；已有结论未自动修改",
      );
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    setBusy(true);
    try {
      const values = await form.validateFields();
      const chosen = new Set(values.choices ?? []);
      const selected = [
        ...scope.recommendations
          .filter((p) => chosen.has(key(p)))
          .map(({ name, version, path }) => ({ name, version, path })),
        ...(values.custom ?? []).map(
          (p: { name: string; version?: string; path?: string }) => ({
            ...p,
            version: p.version ?? "",
            path: p.path ?? "",
          }),
        ),
      ];
      if (!selected.length) {
        message.warning("请选择推荐产品或添加自定义产品");
        return;
      }
      await api(`/projects/${projectId}/product-scope`, {
        method: "PUT",
        body: JSON.stringify({
          expectedRevision: scope.revision,
          selected,
          strategy: values.strategy ?? "",
        }),
      });
      await onRefresh();
      message.success("产品范围已确认，可继续销售项匹配");
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="tab-content">
      <div className="section-toolbar">
        <div>
          <h3>产品选型</h3>
          {scope.knowledgeRelease && (
            <Tag color="blue">知识版本 · {scope.knowledgeRelease.name}</Tag>
          )}
          <p>先基于整份清单比较产品，再按售前策略确定匹配范围。</p>
        </div>
        <Button
          data-guide="recommend-products"
          loading={busy}
          disabled={active || locked || scope.status === "confirmed"}
          onClick={() => {
            setBusy(true);
            void onSend(
              `请结合本项目招标清单，直接调用 wiki_overview 读取固定的 wiki/overview.md 总览，不要搜索或猜测总览路径，比较可能满足需求的产品。我的售前偏好：${form.getFieldValue("strategy") || "暂无额外偏好"}。使用 recommend_products 保存候选产品、覆盖范围、缺口和推荐依据，从总览逐字提取 productId 产品标识、productLine 产品线、department 产品部门、owner 负责人，缺失则留空，基本信息需要 evidence.quote 逐字引用；并通过 combinations 给出1–3套推荐组成，每套明确产品及版本、各产品分工与简洁组合理由。互为替代的产品不要默认组合。只完成产品推荐，等待我在产品选型页选择或自定义并确认后再匹配销售项。`,
            )
              .catch(() => {})
              .finally(() => setBusy(false));
          }}
        >
          生成产品推荐
        </Button>
      </div>
      {scope.status === "legacy" ? (
        <Alert
          type="info"
          showIcon
          message="历史项目保留原匹配结果；比较其它产品策略请新建项目。"
        />
      ) : scope.status === "confirmed" ? (
        <Alert
          type="success"
          showIcon
          message={`已确认产品范围 · 版本 ${scope.revision}`}
          description={scope.selected
            .map((p) => `${p.name}${p.version ? " " + p.version : ""}`)
            .join("、")}
        />
      ) : (
        <Alert
          type="info"
          showIcon
          message="推荐不等于选择。确认产品后，Agent 才会进入销售项匹配。"
        />
      )}
      <Modal
        title="产品推荐详情"
        open={!!detail}
        onCancel={() => setDetailKey(null)}
        footer={
          <Space>
            <Button onClick={() => setDetailKey(null)}>关闭</Button>
            <Button
              type="primary"
              disabled={
                !canChoose ||
                (!!detail && selectedProducts.includes(key(detail)))
              }
              onClick={() => {
                if (detail) {
                  form.setFieldValue("choices", [
                    ...new Set([...selectedProducts, key(detail)]),
                  ]);
                  message.success("已勾选此产品，可继续调整选型");
                  setDetailKey(null);
                }
              }}
            >
              {detail && selectedProducts.includes(key(detail))
                ? "已选中此产品"
                : "选中此产品"}
            </Button>
          </Space>
        }
        width={920}
        style={{ top: 24 }}
        className="product-detail-modal"
      >
        {detail && (
          <div className="recommendation-detail">
            <div className="recommendation-detail-heading">
              <span className="product-card-icon">
                <AppstoreOutlined />
              </span>
              <div>
                <span className="recommendation-eyebrow">
                  候选产品 · 总览初筛
                </span>
                <h3>{detail.productName || detail.name}</h3>
                <Tag>{detail.version || "版本待核实"}</Tag>
              </div>
            </div>
            <details className="recommendation-expand">
              <summary>
                产品基本信息 · {detail.productLine || "产品档案"}
              </summary>
              <ProductBasics product={detail} />
            </details>
            <ProductCatalog
              key={`${projectId}:${key(detail)}`}
              projectId={projectId}
              product={detail}
            />
            <details className="recommendation-expand">
              <summary>产品覆盖能力与待核实项</summary>
              <div className="recommendation-facts">
                <section>
                  <h4>覆盖能力</h4>
                  <div className="recommendation-fact-body">
                    <KnowledgeMarkdown text={detail.coverage} />
                  </div>
                </section>
                <section className="recommendation-caution">
                  <h4>待核实项</h4>
                  <div className="recommendation-fact-body">
                    <KnowledgeMarkdown
                      text={
                        detail.gaps ||
                        "暂无单列缺口，具体规格与授权仍需逐条核实。"
                      }
                    />
                  </div>
                </section>
              </div>
            </details>
            <details className="recommendation-expand">
              <summary>为什么推荐这个产品</summary>
              <KnowledgeMarkdown text={detail.reason} />
            </details>
            <details className="recommendation-expand">
              <summary>查看总览原文证据 · {detail.evidence.length} 条</summary>
              {detail.evidence.map((e, i) => (
                <section className="product-card-evidence" key={i}>
                  <b>
                    L{e.lineStart}–L{e.lineEnd}
                  </b>
                  <KnowledgeMarkdown text={e.quote} />
                </section>
              ))}
              {detail.path && <p className="muted">产品页：{detail.path}</p>}
            </details>
            <p className="recommendation-footnote">
              推荐来自产品总览，销售项、硬指标与授权范围将在确认选型后核实。
            </p>
          </div>
        )}
      </Modal>
      {!!scope.recommendations.length && (
        <section className="recommendation-compositions">
          <div className="composition-heading">
            <h4>推荐选型方案</h4>
            <span>AI 建议如何选择产品</span>
          </div>
          <p className="selection-plan-explainer">
            选择一套建议方案，再确认产品范围。也可以在下方调整产品。
          </p>
          {combinations.length ? (
            combinations.map((c, i) => {
              const chosen =
                c.products.every((p) => selectedProducts.includes(key(p))) &&
                selectedProducts.length === c.products.length;
              return (
                <article
                  className={`composition-card scheme-list-row ${chosen ? "chosen" : ""}`}
                  key={i}
                >
                  <div className="composition-title">
                    <div>
                      <span className="recommendation-eyebrow">
                        方案 {String(i + 1).padStart(2, "0")} ·{" "}
                        {c.products.length === 1 ? "单产品" : "组合产品"}
                      </span>
                      <h4>{c.name}</h4>
                    </div>
                    <Button
                      type={chosen ? "default" : "primary"}
                      disabled={!canChoose}
                      onClick={() => chooseProducts(c.products)}
                    >
                      {chosen ? "已勾选" : "采用这套方案"}
                    </Button>
                  </div>
                  <div className="scheme-members">
                    {c.products.map((p) => (
                      <Tag key={key(p)}>
                        {scope.recommendations.find((r) => key(r) === key(p))
                          ?.productName || p.name}
                        {p.version ? ` · ${p.version}` : ""}
                      </Tag>
                    ))}
                  </div>
                  <p className="composition-summary">{c.summary}</p>
                  <Button
                    type="link"
                    className="scheme-detail-link"
                    onClick={() =>
                      modal.info({
                        title: c.name,
                        width: 600,
                        content: (
                          <div>
                            <KnowledgeMarkdown text={c.summary} />
                            {c.products.map((p) => (
                              <section key={key(p)}>
                                <h5>
                                  {p.name} {p.version}
                                </h5>
                                <KnowledgeMarkdown text={p.role} />
                              </section>
                            ))}
                          </div>
                        ),
                      })
                    }
                  >
                    查看分工与理由
                  </Button>
                </article>
              );
            })
          ) : (
            <div className="selection-plan-empty">
              <div>
                <b>
                  {active || busy ? "正在生成选型建议" : "暂未生成选型建议"}
                </b>
                <p>
                  {active || busy
                    ? "方案生成后会自动列在这里，请关注对话中的进度。"
                    : "自动生成尚未返回方案，可点击重试。不会改变已确认范围。"}
                </p>
              </div>
              <Button
                loading={busy}
                disabled={active || busy || scope.status === "legacy"}
                onClick={() => void generatePlans()}
              >
                重新生成建议
              </Button>
            </div>
          )}
          <p className="recommendation-footnote">
            一键选中会替换候选产品勾选，保留自定义产品；点击“确认产品范围”后生效。
          </p>
        </section>
      )}
      {!!alternatives.length && (
        <section className="product-alternatives">
          <h4>其他产品可满足</h4>
          <p className="muted">
            以下为范围外建议，尚未计入正式匹配及销售清单。加入范围后继续评估。
          </p>
          {alternatives.map(({ id, data: a }) => {
            const included = scope.selected.some(
              (p) => key(p) === key(a.product),
            );
            return (
              <article key={id} className="product-alternative-row">
                <div>
                  <Space wrap>
                    <b>{a.product.name}</b>
                    <Tag>{a.product.version || "版本待核实"}</Tag>
                    <Tag>{a.requirementId}</Tag>
                  </Space>
                  <p>{a.sales}</p>
                  <Button
                    type="link"
                    onClick={() =>
                      modal.info({
                        title: `${a.product.name} · ${a.requirementId}`,
                        width: 640,
                        content: (
                          <>
                            <KnowledgeMarkdown text={a.reason} />
                            <h5>销售项原文证据</h5>
                            <KnowledgeMarkdown text={a.evidence.quote} />
                          </>
                        ),
                      })
                    }
                  >
                    查看能力与证据
                  </Button>
                </div>
                <Button
                  disabled={
                    included || active || busy || scope.status !== "confirmed"
                  }
                  onClick={() =>
                    modal.confirm({
                      title: `将 ${a.product.name} 加入匹配范围？`,
                      content:
                        "保留原产品及已有结论，后续评估可使用新增产品。不会自动纳入报告或销售清单。",
                      okText: "加入范围",
                      onOk: () => addAlternative(a.product),
                    })
                  }
                >
                  {included ? "已加入范围" : "加入匹配范围"}
                </Button>
              </article>
            );
          })}
        </section>
      )}
      <Form
        form={form}
        layout="vertical"
        disabled={locked || active}
        style={{ marginTop: 20 }}
      >
        <div className="candidate-list-toolbar">
          <b>候选产品 · {scope.recommendations.length}</b>
          <Button
            size="small"
            type="text"
            loading={refreshingInfo}
            disabled={active || refreshingInfo || !scope.recommendations.length}
            onClick={() => void refreshProductInfo()}
          >
            更新产品资料
          </Button>
        </div>
        <Form.Item name="choices">
          <Checkbox.Group className="recommended-product-grid">
            {scope.recommendations.map((p) => (
              <article
                data-guide="product-options"
                key={key(p)}
                className={`recommended-product-card ${selectedProducts.includes(key(p)) ? "selected" : ""}`}
              >
                <div
                  className="product-card-heading"
                  onClick={() => setDetailKey(key(p))}
                >
                  <span className="product-card-icon">
                    <AppstoreOutlined />
                  </span>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={`查看 ${p.productName || p.name} 销售项目录`}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setDetailKey(key(p));
                      }
                    }}
                  >
                    <h4>{p.productName || p.name}</h4>
                    <div className="product-card-identity">
                      <code>{p.productId || "标识未提供"}</code>
                      {p.version && <Tag>{p.version}</Tag>}
                    </div>
                  </div>
                  <Checkbox
                    value={key(p)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`选择 ${p.name} ${p.version}`}
                  />
                </div>
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={`查看 ${p.name} 产品资料`}
                  onClick={() => setDetailKey(key(p))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setDetailKey(key(p));
                    }
                  }}
                >
                  <ProductBasics product={p} compact />
                </div>
                <Button
                  className="product-details-button"
                  disabled={false}
                  type="link"
                  onClick={() => setDetailKey(key(p))}
                >
                  查看销售项目录与依据
                </Button>
              </article>
            ))}
          </Checkbox.Group>
        </Form.Item>
        {!scope.recommendations.length && (
          <p className="muted">
            暂无推荐。先上传文件并让 Agent
            读取清单与总览，或直接添加自定义产品。
          </p>
        )}
        <Form.List name="custom">
          {(fields, { add, remove }) => (
            <>
              {fields.map((field) => (
                <div
                  key={field.key}
                  style={{ borderTop: "1px solid #dce4df", paddingTop: 12 }}
                >
                  <Form.Item
                    name={[field.name, "name"]}
                    label="自定义产品名称"
                    rules={[{ required: true, message: "请输入产品名称" }]}
                  >
                    <Input maxLength={200} />
                  </Form.Item>
                  <Space wrap>
                    <Form.Item
                      name={[field.name, "version"]}
                      label="版本（可选）"
                    >
                      <Input maxLength={100} />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, "path"]}
                      label="知识库产品路径（可选）"
                    >
                      <Input
                        placeholder="wiki/entities/product.md"
                        maxLength={500}
                      />
                    </Form.Item>
                  </Space>
                  <Button type="text" danger onClick={() => remove(field.name)}>
                    移除自定义项
                  </Button>
                </div>
              ))}
              <Button
                disabled={locked || active}
                onClick={() => add({ name: "", version: "", path: "" })}
              >
                添加自定义产品
              </Button>
            </>
          )}
        </Form.List>
        <Form.Item
          name="strategy"
          label="本项目售前选择策略"
          style={{ marginTop: 20 }}
        >
          <Input.TextArea
            rows={3}
            maxLength={2000}
            placeholder="例如：优先沿用客户已部署产品；可组合多产品，但尽量减少额外模块。"
          />
        </Form.Item>
        <p className="muted">
          自定义产品仍需在知识库检索核实。产生匹配结果后保留原范围；可从已核实的替代建议追加产品。
        </p>
        <Space wrap>
          <Button
            type="primary"
            loading={busy}
            disabled={locked || active}
            data-guide="confirm-products"
            onClick={() => void confirm()}
          >
            确认产品范围
          </Button>
          {scope.status === "confirmed" && (
            <Button
              data-guide="continue"
              disabled={active || busy}
              onClick={() =>
                void onSend(
                  "产品选型已在界面确认，请先读取项目状态，再按我选定的产品范围、版本和售前策略继续销售项匹配。",
                ).catch(() => {})
              }
            >
              按已选产品继续评估
            </Button>
          )}
        </Space>
      </Form>
    </div>
  );
}
