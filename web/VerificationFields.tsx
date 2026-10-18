import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
} from "antd";
import type { AssessmentInput, Requirement, Workspace } from "../shared/domain";

type Path = (string | number)[];
const outcomes = ["exact", "partial", "no_match", "unknown"].map(
  (value, i) => ({
    value,
    label: ["完全满足", "部分满足", "不满足", "待确认"][i],
  }),
);
const deliveries = [
  "native",
  "configuration",
  "integration",
  "customization",
  "external",
  "unknown",
].map((value, i) => ({
  value,
  label: [
    "原生功能",
    "配置实现",
    "集成实现",
    "需要定制",
    "依赖外部条件",
    "待确认",
  ][i],
}));
const purposes = [
  "purchase",
  "dependency",
  "existing",
  "optional",
  "candidate",
].map((value, i) => ({
  value,
  label: ["新增采购", "正式依赖", "已有授权复用", "可选增强", "仅比较候选"][i],
}));
const text = (label: string, name: Path, required = true) => (
  <Form.Item
    key={name.join(".")}
    label={label}
    name={name}
    rules={required ? [{ required: true, message: `请填写${label}` }] : []}
  >
    <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} />
  </Form.Item>
);

function Proofs({
  name,
  snapshots,
}: {
  name: Path;
  snapshots: Workspace["snapshots"];
}) {
  return (
    <Form.List name={name}>
      {(fields, { add, remove }) => (
        <div className="verification-proofs">
          {fields.map((field) => (
            <section key={field.key} className="verification-proof">
              <Form.Item
                name={[field.name, "snapshotId"]}
                label="证据页面"
                rules={[{ required: true, message: "请选择证据页面" }]}
              >
                <Select
                  showSearch
                  optionFilterProp="label"
                  options={snapshots.map((s) => ({
                    value: s.id,
                    label: s.path,
                  }))}
                />
              </Form.Item>
              <Space wrap>
                <Form.Item
                  name={[field.name, "lineStart"]}
                  label="起始行"
                  rules={[{ required: true }]}
                >
                  <InputNumber min={1} precision={0} />
                </Form.Item>
                <Form.Item
                  name={[field.name, "lineEnd"]}
                  label="结束行"
                  rules={[{ required: true }]}
                >
                  <InputNumber min={1} precision={0} />
                </Form.Item>
                <Button danger type="text" onClick={() => remove(field.name)}>
                  移除证据
                </Button>
              </Space>
              {text("逐字证据摘录", [field.name, "quote"])}
            </section>
          ))}
          <Button onClick={() => add({ lineStart: 1, lineEnd: 1, quote: "" })}>
            添加证据
          </Button>
        </div>
      )}
    </Form.List>
  );
}

export function VerificationFields({
  requirement,
  snapshots,
  selected,
  searchTrace,
}: {
  requirement?: Requirement;
  snapshots: Workspace["snapshots"];
  selected: Workspace["productScope"]["selected"];
  searchTrace: Workspace["searchTrace"];
}) {
  const form = Form.useFormInstance();
  const verification = Form.useWatch("verification", {
    form,
    preserve: true,
  }) as AssessmentInput["verification"];
  const subOptions = (requirement?.subrequirements ?? []).map((s) => ({
    value: s.id,
    label: `${s.id} · ${s.raw}`,
  }));
  if (!verification)
    return (
      <Alert
        type="warning"
        showIcon
        message="历史结果尚未逐子要求核验"
        description={
          <>
            <p>
              保留历史标识可直接修订说明。升级核验需先在技术条款中补全子要求，再逐项核实证据。
            </p>
            <Button
              disabled={!subOptions.length}
              onClick={() =>
                form.setFieldValue("verification", {
                  version: 2,
                  checks: requirement!.subrequirements!.map((s) => ({
                    subrequirementId: s.id,
                    level: "unknown",
                    direction: "",
                    reason: "",
                    delivery: "unknown",
                    deliveryConfirmed: false,
                    evidence: [],
                  })),
                  contributions: [],
                  integrationRequired: false,
                  integrations: [],
                  supplementalSearch: [],
                  counterchecks: {
                    direction: "",
                    omissions: "",
                    quantitative: "",
                    external: "",
                    integration: "",
                  },
                })
              }
            >
              开始新版核验
            </Button>
          </>
        }
      />
    );
  const contributionOptions =
    verification.contributions?.map((c) => ({
      value: c.id,
      label: `${c.id} · ${c.product} / ${c.sales}`,
    })) ?? [];
  return (
    <div className="verification-editor">
      <Alert
        type="info"
        showIcon
        message="逐项核实后保存"
        description="证据必须来自已读取页面。总体结论需要与必需子要求及交付、联动条件一致；保存时后端会再次校验。"
      />
      <Collapse
        defaultActiveKey={["checks"]}
        items={[
          {
            key: "checks",
            label: "子要求与交付条件",
            children: (
              <Form.List name={["verification", "checks"]}>
                {(fields) => (
                  <>
                    {fields.map((f) => (
                      <section className="verification-section" key={f.key}>
                        <Form.Item
                          name={[f.name, "subrequirementId"]}
                          label="子要求"
                        >
                          <Select options={subOptions} disabled />
                        </Form.Item>
                        <Form.Item
                          name={[f.name, "level"]}
                          label="核验结论"
                          rules={[{ required: true }]}
                        >
                          <Select options={outcomes} />
                        </Form.Item>
                        {text("能力方向", [f.name, "direction"])}
                        {text("判断原因", [f.name, "reason"])}
                        <Form.Item name={[f.name, "delivery"]} label="交付方式">
                          <Select options={deliveries} />
                        </Form.Item>
                        <Form.Item
                          name={[f.name, "deliveryConfirmed"]}
                          valuePropName="checked"
                        >
                          <Checkbox>交付条件已核实</Checkbox>
                        </Form.Item>
                        <Proofs
                          name={[f.name, "evidence"]}
                          snapshots={snapshots}
                        />
                        <Form.Item noStyle shouldUpdate>
                          {() => {
                            const path: Path = [
                              "verification",
                              "checks",
                              f.name,
                              "quantitative",
                            ];
                            const numeric = form.getFieldValue(path);
                            return numeric ? (
                              <div className="verification-proof">
                                <Form.Item
                                  name={[f.name, "quantitative", "operator"]}
                                  label="要求比较方向"
                                >
                                  <Select
                                    options={[">=", ">", "<=", "<", "="].map(
                                      (value) => ({ value, label: value }),
                                    )}
                                  />
                                </Form.Item>
                                <Space wrap>
                                  <Form.Item
                                    name={[
                                      f.name,
                                      "quantitative",
                                      "requiredValue",
                                    ]}
                                    label="要求数值"
                                    rules={[{ required: true }]}
                                  >
                                    <InputNumber />
                                  </Form.Item>
                                  <Form.Item
                                    name={[
                                      f.name,
                                      "quantitative",
                                      "actualValue",
                                    ]}
                                    label="产品实际数值"
                                  >
                                    <InputNumber />
                                  </Form.Item>
                                </Space>
                                {text("要求单位", [
                                  f.name,
                                  "quantitative",
                                  "unit",
                                ])}
                                {text(
                                  "实际单位",
                                  [f.name, "quantitative", "actualUnit"],
                                  false,
                                )}
                                {text("适用条件", [
                                  f.name,
                                  "quantitative",
                                  "condition",
                                ])}
                                <Form.Item
                                  name={[f.name, "quantitative", "confirmed"]}
                                  valuePropName="checked"
                                >
                                  <Checkbox>
                                    数值、单位及适用条件已核实
                                  </Checkbox>
                                </Form.Item>
                                <Button
                                  onClick={() =>
                                    form.setFieldValue(path, undefined)
                                  }
                                >
                                  移除量化条件
                                </Button>
                              </div>
                            ) : (
                              <Button
                                onClick={() =>
                                  form.setFieldValue(path, {
                                    operator: ">=",
                                    requiredValue: 0,
                                    unit: "",
                                    condition: "",
                                    confirmed: false,
                                  })
                                }
                              >
                                添加量化条件
                              </Button>
                            );
                          }}
                        </Form.Item>
                      </section>
                    ))}
                  </>
                )}
              </Form.List>
            ),
          },
          {
            key: "contributions",
            label: "产品与销售项选用",
            children: (
              <Form.List name={["verification", "contributions"]}>
                {(fields, { add, remove }) => (
                  <>
                    {fields.map((f) => (
                      <section className="verification-section" key={f.key}>
                        {text("贡献编号", [f.name, "id"])}
                        <Form.Item
                          name={[f.name, "product"]}
                          label="产品"
                          rules={[{ required: true }]}
                        >
                          <Select
                            options={selected.map((p) => ({
                              value: p.name,
                              label: p.name,
                            }))}
                          />
                        </Form.Item>
                        {text("版本", [f.name, "version"])}
                        {text("销售项名称", [f.name, "sales"])}
                        {text("实体路径", [f.name, "path"])}
                        {text("模块标识", [f.name, "moduleId"])}
                        <Form.Item name={[f.name, "purpose"]} label="选用用途">
                          <Select options={purposes} />
                        </Form.Item>
                        <Form.Item
                          name={[f.name, "subrequirementIds"]}
                          label="对应子要求"
                        >
                          <Select mode="multiple" options={subOptions} />
                        </Form.Item>
                        {text("贡献能力", [f.name, "capability"])}
                        {text("选用原因", [f.name, "reason"])}
                        <Proofs
                          name={[f.name, "evidence"]}
                          snapshots={snapshots}
                        />
                        <Button danger onClick={() => remove(f.name)}>
                          移除贡献项
                        </Button>
                      </section>
                    ))}
                    <Button
                      onClick={() =>
                        add({
                          id: `C-${Date.now()}`,
                          product: selected[0]?.name ?? "",
                          version: selected[0]?.version ?? "",
                          sales: "",
                          path: "",
                          moduleId: "",
                          purpose: "candidate",
                          subrequirementIds: [],
                          capability: "",
                          reason: "",
                          evidence: [],
                        })
                      }
                    >
                      添加产品贡献项
                    </Button>
                  </>
                )}
              </Form.List>
            ),
          },
          {
            key: "integrations",
            label: "跨产品联动",
            children: (
              <>
                <Form.Item
                  name={["verification", "integrationRequired"]}
                  valuePropName="checked"
                >
                  <Checkbox>需要核实跨产品联动</Checkbox>
                </Form.Item>
                <Form.List name={["verification", "integrations"]}>
                  {(fields, { add, remove }) => (
                    <>
                      {fields.map((f) => (
                        <section key={f.key} className="verification-section">
                          <Form.Item name={[f.name, "from"]} label="上游贡献项">
                            <Select options={contributionOptions} />
                          </Form.Item>
                          <Form.Item name={[f.name, "to"]} label="下游贡献项">
                            <Select options={contributionOptions} />
                          </Form.Item>
                          {text("接口或协议", [f.name, "protocol"])}
                          {text("数据方向", [f.name, "direction"])}
                          {text("兼容条件", [f.name, "compatibility"])}
                          {text("配置条件", [f.name, "configuration"])}
                          {text("授权条件", [f.name, "authorization"])}
                          <Form.Item
                            name={[f.name, "confirmed"]}
                            valuePropName="checked"
                          >
                            <Checkbox>联动条件已核实</Checkbox>
                          </Form.Item>
                          <Proofs
                            name={[f.name, "evidence"]}
                            snapshots={snapshots}
                          />
                          <Button danger onClick={() => remove(f.name)}>
                            移除联动
                          </Button>
                        </section>
                      ))}
                      <Button
                        onClick={() =>
                          add({
                            from: "",
                            to: "",
                            protocol: "",
                            direction: "",
                            compatibility: "",
                            configuration: "",
                            authorization: "",
                            confirmed: false,
                            evidence: [],
                          })
                        }
                      >
                        添加联动
                      </Button>
                    </>
                  )}
                </Form.List>
              </>
            ),
          },
          {
            key: "counterchecks",
            label: "反证检查",
            children: (
              <>
                {Object.entries({
                  direction: "能力方向是否相反",
                  omissions: "是否遗漏子要求",
                  quantitative: "数值与单位是否一致",
                  external: "外部条件是否明确",
                  integration: "跨产品联动是否成立",
                }).map(([key, label]) =>
                  text(label, ["verification", "counterchecks", key]),
                )}
              </>
            ),
          },
          {
            key: "supplemental",
            label: "补充检索记录",
            children: (
              <Form.List name={["verification", "supplementalSearch"]}>
                {(fields, { add, remove }) => (
                  <>
                    {fields.map((f) => (
                      <section key={f.key} className="verification-section">
                        <Form.Item
                          name={[f.name, "subrequirementId"]}
                          label="子要求"
                        >
                          <Select options={subOptions} />
                        </Form.Item>
                        {text("检索关键词", [f.name, "query"])}
                        {text("补查结论", [f.name, "outcome"])}
                        <Form.Item
                          name={[f.name, "traceId"]}
                          label="真实检索记录"
                        >
                          <Select
                            options={searchTrace
                              .filter(
                                (t) => t.data.requirementId === requirement?.id,
                              )
                              .map((t) => ({
                                value: t.id,
                                label: `#${t.id} ${t.data.query}`,
                              }))}
                          />
                        </Form.Item>
                        <Button danger onClick={() => remove(f.name)}>
                          移除补查
                        </Button>
                      </section>
                    ))}
                    <Button
                      onClick={() =>
                        add({ subrequirementId: "", query: "", outcome: "" })
                      }
                    >
                      关联补查记录
                    </Button>
                  </>
                )}
              </Form.List>
            ),
          },
        ]}
      />
    </div>
  );
}
