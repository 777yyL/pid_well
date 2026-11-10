import { useState, useEffect } from "react";
import { App, Alert, Button, Empty, Input, Modal, Space } from "antd";
import { api, post } from "./api";
import { KnowledgeMarkdown } from "./KnowledgeReader";
import type { ProductOverview } from "../shared/product-knowledge";
export function KnowledgeOverview({
  overview,
  onClose,
}: {
  overview: { product_version_id: string; version: string };
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const [overviewData, setOverviewData] = useState<{
    current: ProductOverview | null;
    job: { status: string; error?: string } | null;
  } | null>(null);
  const [overviewText, setOverviewText] = useState(""),
    [overviewDirty, setOverviewDirty] = useState(false),
    [revision, setRevision] = useState(0),
    [error, setError] = useState("");
  useEffect(() => {
    if (!overview) return;
    const c = new AbortController();
    const load = () =>
      void api<NonNullable<typeof overviewData>>(
        `/knowledge/admin/overviews/${encodeURIComponent(overview.product_version_id)}`,
        { signal: c.signal },
      )
        .then((value) => {
          if (c.signal.aborted) return;
          setOverviewData(value);
        })
        .catch((e) => {
          if (!c.signal.aborted) setError(e.message);
        });
    load();
    const timer = setInterval(load, 3000);
    return () => {
      c.abort();
      clearInterval(timer);
    };
  }, [overview, revision]);
  return (
    <Modal
      title={`${overview?.version ?? ""} 产品概览`}
      open={!!overview}
      onCancel={onClose}
      footer={null}
      width={850}
      styles={{ body: { maxHeight: "70dvh", overflowY: "auto" } }}
    >
      {error && <Alert type="error" message={error} />}
      <p className="muted">
        仅根据此版本的销售项生成，用于产品推荐；每个业务模块关联销售项
        ID。人工修改后不会被自动覆盖。
      </p>
      {overviewData?.current?.stale && (
        <Alert
          type="warning"
          showIcon
          message="销售项已变化，当前概览待更新，推荐时不使用旧概览。"
        />
      )}
      {overviewData?.job?.error && (
        <Alert type="error" message={overviewData.job.error} />
      )}
      {overviewData?.current?.generation_error && (
        <Alert
          type="error"
          message={`概览自动更新失败：${overviewData.current.generation_error}。可检查 Agent 连接后重新生成。`}
        />
      )}
      <Space wrap style={{ margin: "16px 0" }}>
        <Button
          type="primary"
          loading={overviewData?.job?.status === "running"}
          onClick={async () => {
            try {
              await post(
                `/knowledge/admin/overviews/${encodeURIComponent(overview!.product_version_id)}/generate`,
                {},
              );
              setRevision((n) => n + 1);
            } catch (e) {
              message.error((e as Error).message);
            }
          }}
        >
          从销售项生成概览
        </Button>
        <Button
          disabled={!overviewData?.current}
          onClick={() => {
            setOverviewText(
              JSON.stringify(overviewData!.current!.overview, null, 2),
            );
            setOverviewDirty(true);
          }}
        >
          编辑结构化概览
        </Button>
      </Space>
      {overviewDirty ? (
        <>
          <Input.TextArea
            aria-label="产品概览 JSON"
            value={overviewText}
            onChange={(e) => setOverviewText(e.target.value)}
            autoSize={{ minRows: 16, maxRows: 26 }}
          />
          <Button
            style={{ marginTop: 12 }}
            onClick={async () => {
              try {
                await api(
                  `/knowledge/admin/overviews/${encodeURIComponent(overview!.product_version_id)}`,
                  {
                    method: "PUT",
                    body: JSON.stringify(JSON.parse(overviewText)),
                  },
                );
                setOverviewDirty(false);
                setRevision((n) => n + 1);
                message.success("概览已保存");
              } catch (e) {
                message.error((e as Error).message);
              }
            }}
          >
            保存人工修订
          </Button>
        </>
      ) : overviewData?.current ? (
        <KnowledgeMarkdown
          text={`## ${overviewData.current.overview.positioning}\n${overviewData.current.overview.scenarios.join("、")}\n${overviewData.current.overview.modules.map((m) => `### ${m.name}\n${m.capabilities.map((c) => "- " + c).join("\n")}\n\n支撑销售项：${m.saleItemIds.join("、")}`).join("\n")}\n## 限制与前提\n${overviewData.current.overview.limitations.join("\n") || "未明确"}\n## 待核实\n${overviewData.current.overview.unspecified.join("\n") || "未明确"}`}
        />
      ) : (
        <Empty description="尚未生成此版本的产品概览" />
      )}
    </Modal>
  );
}
