import {
  Drawer,
  Button,
  Space,
  Form,
  Select,
  Input,
  InputNumber,
  type FormInstance,
} from "antd";
import {
  types,
  fields,
  labels,
  longFields,
  enums,
  type Row,
} from "./knowledge-fields";
export function KnowledgeEditor({
  tab,
  edit,
  form,
  refs,
  versionOptions,
  saving,
  onSave,
  onClose,
}: {
  tab: string;
  edit: Row | null;
  form: FormInstance;
  refs: { products: Row[]; versions: Row[]; categories: Row[]; sales: Row[] };
  versionOptions: { value: string; label: string }[];
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
}) {
  const config = types.find((t) => t[0] === tab);
  const selectedVersion = Form.useWatch("product_version_id", form);
  return (
    <Drawer
      title={`${edit?.isNew ? "新增" : "编辑"}${config?.[1] ?? ""}`}
      open={!!edit}
      onClose={onClose}
      width={780}
      extra={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={onSave}>
            保存
          </Button>
        </Space>
      }
    >
      {edit && (
        <Form
          form={form}
          layout="vertical"
          className="knowledge-editor"
          requiredMark={false}
        >
          {fields[tab].map((field) => {
            const key = config![2],
              options =
                field === key
                  ? undefined
                  : field === "product_id"
                    ? refs.products.map((p) => ({
                        value: p.product_id,
                        label: p.product_code + " · " + p.name,
                      }))
                    : field === "product_version_id"
                      ? versionOptions
                      : field === "category_id"
                        ? refs.categories
                            .filter(
                              (c) => c.product_version_id === selectedVersion,
                            )
                            .map((c) => ({
                              value: c.category_id,
                              label: c.name,
                            }))
                        : ["sale_item_id", "depends_on_sale_item_id"].includes(
                              field,
                            )
                          ? refs.sales.map((s) => ({
                              value: s.sale_item_id,
                              label:
                                s.name +
                                " · " +
                                (versionOptions.find(
                                  (v) => v.value === s.product_version_id,
                                )?.label ?? s.product_version_id),
                            }))
                          : enums[field];
            const required = [
              key,
              "name",
              "product_code",
              "product_id",
              "product_version_id",
              "version",
              "price_type",
              "dependency_type",
              "source_note",
              "sale_item_id",
              "depends_on_sale_item_id",
              "status",
              "sort_order",
            ].includes(field);
            return (
              <Form.Item
                key={field}
                name={field}
                label={field === key ? "稳定 ID" : labels[field]}
                className={longFields.has(field) ? "wide" : ""}
                rules={
                  required
                    ? [
                        {
                          required: true,
                          message: "请填写" + (labels[field] ?? "ID"),
                        },
                      ]
                    : undefined
                }
              >
                {options ? (
                  <Select
                    allowClear={!required}
                    showSearch
                    optionFilterProp="label"
                    options={options}
                    onChange={
                      field === "product_version_id"
                        ? () => form.setFieldValue("category_id", undefined)
                        : undefined
                    }
                  />
                ) : ["sort_order", "fixed_price", "source_row"].includes(
                    field,
                  ) ? (
                  <InputNumber
                    style={{ width: "100%" }}
                    min={field === "sort_order" ? undefined : 0}
                  />
                ) : longFields.has(field) ? (
                  <Input.TextArea
                    autoSize={{
                      minRows: field === "specification_md" ? 8 : 3,
                      maxRows: 18,
                    }}
                  />
                ) : (
                  <Input
                    disabled={field === key && !edit.isNew}
                    placeholder={
                      field === "version"
                        ? "例如 v2.1.0"
                        : field === "effective_date"
                          ? "YYYY-MM-DD"
                          : undefined
                    }
                  />
                )}
              </Form.Item>
            );
          })}
        </Form>
      )}
    </Drawer>
  );
}
