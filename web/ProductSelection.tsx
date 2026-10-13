import { useEffect, useState } from "react";
import {
  Alert,
  App as AntApp,
  Button,
  Checkbox,
  Form,
  Input,
  Space,
  Tag,
} from "antd";
import type { ProductScope } from "../shared/domain";
import { api } from "./api";
import { KnowledgeMarkdown } from "./KnowledgeReader";
import { AppstoreOutlined } from "@ant-design/icons";
const key = (p: { name: string; version: string }) =>
  JSON.stringify([p.name, p.version]);
export function ProductSelection({
  projectId,
  scope,
  locked,
  active,
  onRefresh,
  onSend,
}: {
  projectId: string;
  scope: ProductScope;
  locked: boolean;
  active: boolean;
  onRefresh: () => Promise<void>;
  onSend: (text: string) => Promise<void>;
}) {
  const [form] = Form.useForm();
  const selectedProducts: string[] = Form.useWatch("choices", form) ?? [];
  const [busy, setBusy] = useState(false);
  const { message } = AntApp.useApp();
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
          <p>先基于整份清单比较产品，再按售前策略确定匹配范围。</p>
        </div>
        <Button
          loading={busy}
          disabled={active || locked || scope.status === "confirmed"}
          onClick={() => {
            setBusy(true);
            void onSend(
              `请结合本项目招标清单，读取知识库总览，比较可能满足需求的产品。我的售前偏好：${form.getFieldValue("strategy") || "暂无额外偏好"}。使用 recommend_products 保存候选产品、覆盖范围、缺口和推荐依据。只完成产品推荐，等待我在产品选型页选择或自定义并确认后再匹配销售项。`,
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
      <Form
        form={form}
        layout="vertical"
        disabled={locked || active}
        style={{ marginTop: 20 }}
      >
        <Form.Item name="choices" label="推荐候选产品">
          <Checkbox.Group className="recommended-product-grid">
            {scope.recommendations.map((p) => (
              <article
                key={key(p)}
                className={`recommended-product-card ${selectedProducts.includes(key(p)) ? "selected" : ""}`}
              >
                <div className="product-card-heading">
                  <span className="product-card-icon">
                    <AppstoreOutlined />
                  </span>
                  <div>
                    <h4>{p.name}</h4>
                    {p.version && <Tag>{p.version}</Tag>}
                  </div>
                  <Checkbox
                    value={key(p)}
                    aria-label={`选择 ${p.name} ${p.version}`}
                  />
                </div>
                <p className="product-card-summary">{p.reason}</p>
                <div className="product-card-meta">
                  <span>{p.evidence.length} 条推荐证据</span>
                  {p.gaps && (
                    <span className="product-gap-label">有待核实项</span>
                  )}
                </div>
                <details className="product-card-details">
                  <summary>查看推荐理由与覆盖情况</summary>
                  <div className="knowledge-markdown">
                    <h5>推荐理由</h5>
                    <KnowledgeMarkdown text={p.reason} />
                    <h5>覆盖方向</h5>
                    <KnowledgeMarkdown text={p.coverage} />
                    {p.gaps && (
                      <>
                        <h5>待核实 / 缺口</h5>
                        <KnowledgeMarkdown text={p.gaps} />
                      </>
                    )}
                    {p.path && <p className="muted">产品页：{p.path}</p>}
                    {p.evidence.map((e, i) => (
                      <section className="product-card-evidence" key={i}>
                        <b>
                          总览证据 L{e.lineStart}–L{e.lineEnd}
                        </b>
                        <KnowledgeMarkdown text={e.quote} />
                      </section>
                    ))}
                  </div>
                </details>
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
          自定义产品仍需在知识库检索核实。产生匹配结果后锁定范围，避免混入不同选型的结论。
        </p>
        <Space wrap>
          <Button
            type="primary"
            loading={busy}
            disabled={locked || active}
            onClick={() => void confirm()}
          >
            确认产品范围
          </Button>
          {scope.status === "confirmed" && (
            <Button
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
