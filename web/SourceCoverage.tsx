import { coverageLabel } from "../shared/accuracy";
import { useState } from "react";
import {
  Alert,
  App,
  Button,
  Collapse,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
} from "antd";
import type { Workspace } from "../shared/domain";
import { api } from "./api";

function CoverageEditor({
  workspace,
  record,
  refresh,
}: {
  workspace: Workspace;
  record: NonNullable<Workspace["sourceCoverage"]>[number];
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const requirements = workspace.requirements.filter(
    (r) => r.documentId === record.documentId,
  );
  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={{ entries: record.entries }}
      onFinish={async (values) => {
        setBusy(true);
        try {
          await api(`/projects/${workspace.project.id}/source-coverage`, {
            method: "PUT",
            body: JSON.stringify({
              documentId: record.documentId,
              entries: values.entries,
            }),
          });
          await refresh();
          message.success("原文覆盖人工检查已保存");
        } catch (e) {
          message.error(e instanceof Error ? e.message : "保存失败");
        } finally {
          setBusy(false);
        }
      }}
    >
      <Alert
        type="info"
        message={`未检查 ${record.uncheckedLines.length} 行`}
        description={`行号：${record.uncheckedLines.slice(0, 40).join("、") || "无"}${record.uncheckedLines.length > 40 ? "…" : ""}。请对照原文登记条目，不能以已抽取条款数代替完整性检查。`}
      />
      <Form.List
        name="entries"
        rules={[
          {
            validator: (_, v) =>
              v?.length
                ? Promise.resolve()
                : Promise.reject(new Error("请至少登记一个原文条目")),
          },
        ]}
      >
        {(fields, { add, remove }, { errors }) => (
          <>
            {fields.map((f) => (
              <section className="verification-section" key={f.key}>
                <Form.Item
                  label="条目编号"
                  name={[f.name, "id"]}
                  rules={[{ required: true }]}
                >
                  <Input />
                </Form.Item>
                <Space wrap>
                  <Form.Item
                    label="起始行"
                    name={[f.name, "lineStart"]}
                    rules={[{ required: true }]}
                  >
                    <InputNumber min={1} precision={0} />
                  </Form.Item>
                  <Form.Item
                    label="结束行"
                    name={[f.name, "lineEnd"]}
                    rules={[{ required: true }]}
                  >
                    <InputNumber min={1} precision={0} />
                  </Form.Item>
                </Space>
                <Form.Item
                  label="检查状态"
                  name={[f.name, "status"]}
                  rules={[{ required: true }]}
                >
                  <Select
                    options={[
                      { value: "extracted", label: "已抽取为要求" },
                      { value: "excluded", label: "明确排除" },
                      { value: "pending", label: "待检查" },
                    ]}
                  />
                </Form.Item>
                <Form.Item label="关联条款" name={[f.name, "requirementIds"]}>
                  <Select
                    mode="multiple"
                    options={requirements.map((r) => ({
                      value: r.id,
                      label: `${r.id} · ${r.raw}`,
                    }))}
                  />
                </Form.Item>
                <Form.Item
                  label="关联子要求"
                  name={[f.name, "subrequirementIds"]}
                >
                  <Select
                    mode="multiple"
                    options={requirements.flatMap((r) =>
                      (r.subrequirements ?? []).map((s) => ({
                        value: s.id,
                        label: `${s.id} · ${s.raw}`,
                      })),
                    )}
                  />
                </Form.Item>
                <Form.Item
                  label="判断或排除理由"
                  name={[f.name, "reason"]}
                  rules={[{ required: true }]}
                >
                  <Input.TextArea rows={2} />
                </Form.Item>
                <Button danger onClick={() => remove(f.name)}>
                  移除条目
                </Button>
              </section>
            ))}
            <Form.ErrorList errors={errors} />
            <Space wrap>
              <Button
                onClick={() =>
                  add({
                    id: `entry-${Date.now()}`,
                    lineStart: record.uncheckedLines[0] ?? 1,
                    lineEnd: record.uncheckedLines[0] ?? 1,
                    status: "pending",
                    reason: "",
                    requirementIds: [],
                    subrequirementIds: [],
                  })
                }
              >
                添加原文条目
              </Button>
              <Button type="primary" htmlType="submit" loading={busy}>
                保存人工原文检查
              </Button>
            </Space>
          </>
        )}
      </Form.List>
    </Form>
  );
}
export function SourceCoverage({
  workspace,
  refresh,
}: {
  workspace: Workspace;
  refresh: () => Promise<void>;
}) {
  return (
    <Collapse
      items={(workspace.sourceCoverage ?? []).map((record) => ({
        key: record.documentId,
        label: `${record.name} · 原文覆盖 ${coverageLabel(record.status)}`,
        children: (
          <CoverageEditor
            key={JSON.stringify(record.entries)}
            workspace={workspace}
            record={record}
            refresh={refresh}
          />
        ),
      }))}
    />
  );
}
