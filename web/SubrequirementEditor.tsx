import { useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Space,
} from "antd";
import type { Requirement } from "../shared/domain";
import { api } from "./api";

export function SubrequirementEditor({
  projectId,
  requirement,
  refresh,
}: {
  projectId: string;
  requirement: Requirement;
  refresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [form] = Form.useForm();
  const { message } = App.useApp();
  if (!requirement.confirmed || requirement.subrequirements?.length)
    return (
      <span>
        {requirement.subrequirements?.length
          ? `${requirement.subrequirements.length} 个核验点`
          : "确认原文后补全"}
      </span>
    );
  return (
    <>
      <Button
        size="small"
        onClick={() => {
          form.setFieldsValue({
            subrequirements: [
              {
                id: `${requirement.id}.1`,
                raw: requirement.raw,
                required: true,
                lineStart: requirement.lineStart,
                lineEnd: requirement.lineEnd,
              },
            ],
          });
          setOpen(true);
        }}
      >
        补全核验点
      </Button>
      <Modal
        title={`${requirement.id} · 补全子要求`}
        open={open}
        width={700}
        confirmLoading={busy}
        okText="确认并保存核验点"
        onCancel={() => setOpen(false)}
        onOk={async () => {
          setBusy(true);
          try {
            const values = await form.validateFields();
            await api(
              `/projects/${projectId}/requirements/${encodeURIComponent(requirement.id)}/subrequirements`,
              {
                method: "PUT",
                body: JSON.stringify({
                  ...values,
                  expectedSubrequirements: requirement.subrequirements ?? null,
                }),
              },
            );
            await refresh();
            setOpen(false);
            message.success("核验点已确认，原条款与已有评估结果已保留");
          } catch (e) {
            if (e instanceof Error) message.error(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Alert
          type="info"
          showIcon
          message="只补全核验点，保留父条款原文及人工结果"
          description="每个核验点应逐字摘自父条款，并对应正确原文行号。确认后不能在此替换，请保存前核对。"
        />
        <blockquote style={{ whiteSpace: "pre-wrap" }}>
          {requirement.raw}
        </blockquote>
        <Form form={form} layout="vertical">
          <Form.List
            name="subrequirements"
            rules={[
              {
                validator: (_, v) =>
                  v?.length
                    ? Promise.resolve()
                    : Promise.reject(new Error("至少保留一个核验点")),
              },
            ]}
          >
            {(fields, { add, remove }, { errors }) => (
              <>
                {fields.map((f) => (
                  <section className="verification-section" key={f.key}>
                    <Form.Item
                      name={[f.name, "id"]}
                      label="核验点编号"
                      rules={[{ required: true }]}
                    >
                      <Input />
                    </Form.Item>
                    <Form.Item
                      name={[f.name, "raw"]}
                      label="原文摘录"
                      rules={[{ required: true }]}
                    >
                      <Input.TextArea rows={2} />
                    </Form.Item>
                    <Space wrap>
                      <Form.Item
                        name={[f.name, "lineStart"]}
                        label="起始行"
                        rules={[{ required: true }]}
                      >
                        <InputNumber
                          min={requirement.lineStart}
                          max={requirement.lineEnd}
                          precision={0}
                        />
                      </Form.Item>
                      <Form.Item
                        name={[f.name, "lineEnd"]}
                        label="结束行"
                        rules={[{ required: true }]}
                      >
                        <InputNumber
                          min={requirement.lineStart}
                          max={requirement.lineEnd}
                          precision={0}
                        />
                      </Form.Item>
                    </Space>
                    <Form.Item
                      name={[f.name, "required"]}
                      valuePropName="checked"
                    >
                      <Checkbox>必须满足</Checkbox>
                    </Form.Item>
                    <Button danger onClick={() => remove(f.name)}>
                      移除核验点
                    </Button>
                  </section>
                ))}
                <Form.ErrorList errors={errors} />
                <Button
                  onClick={() =>
                    add({
                      id: `${requirement.id}.${Date.now()}`,
                      raw: "",
                      required: true,
                      lineStart: requirement.lineStart,
                      lineEnd: requirement.lineEnd,
                    })
                  }
                >
                  添加核验点
                </Button>
              </>
            )}
          </Form.List>
        </Form>
      </Modal>
    </>
  );
}
