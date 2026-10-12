import { useRef, useState } from "react";
import {
  Alert,
  App as AntApp,
  Button,
  Input,
  Modal,
  Popconfirm,
  Select,
  Spin,
  Tag,
} from "antd";
import type { InputRef } from "antd";
import { CopyOutlined, ShareAltOutlined } from "@ant-design/icons";
import type { ShareLink } from "../shared/share";
import { api, post } from "./api";
function CopyLink({ url }: { url: string }) {
  const ref = useRef<InputRef>(null),
    { message } = AntApp.useApp();
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      message.success("分享链接已复制");
    } catch {
      ref.current?.input?.select();
      if (document.execCommand("copy")) message.success("分享链接已复制");
      else message.info("链接已选中，请按 Ctrl+C 复制");
    }
  }
  return (
    <div className="share-copy">
      <Input ref={ref} readOnly value={url} aria-label="分享链接" />
      <Button icon={<CopyOutlined />} onClick={() => void copy()}>
        复制链接
      </Button>
    </div>
  );
}
export function ShareDialog({
  projectId,
  enabled,
  onRefresh,
}: {
  projectId: string;
  enabled: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false);
  const [links, setLinks] = useState<ShareLink[]>([]),
    [days, setDays] = useState(30),
    [error, setError] = useState("");
  const { message } = AntApp.useApp();
  async function show() {
    setOpen(true);
    setLoading(true);
    setError("");
    try {
      setLinks(await api<ShareLink[]>(`/projects/${projectId}/shares`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  async function create() {
    setBusy(true);
    setError("");
    try {
      const link = await post<ShareLink>(`/projects/${projectId}/shares`, {
        days,
      });
      setLinks((current) => [link, ...current]);
      message.success("成果与下载文件已固定，可复制链接分享");
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    setBusy(true);
    try {
      await post(`/projects/${projectId}/shares/${id}/revoke`);
      setLinks((current) =>
        current.map((link) =>
          link.id === id
            ? { ...link, revoked_at: new Date().toISOString() }
            : link,
        ),
      );
      message.success("分享已撤销");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button icon={<ShareAltOutlined />} onClick={() => void show()}>
        分享成果
      </Button>
      <Modal
        title="分享评估成果"
        open={open}
        onCancel={() => !busy && setOpen(false)}
        footer={null}
        width={720}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          message="持有链接的同事无需登录即可查看结果并下载成果物"
          description="仅分享本次已完成的评估、证据摘录和报告，不开放编辑、会话或原始上传文件。后续修改不影响已分享版本，可随时撤销链接。"
        />
        <div className="share-create">
          <span>有效期</span>
          <Select
            value={days}
            onChange={setDays}
            options={[7, 30, 90].map((value) => ({
              value,
              label: `${value} 天`,
            }))}
            disabled={busy}
          />
          <Button
            type="primary"
            loading={busy}
            disabled={!enabled || loading}
            onClick={() => void create()}
          >
            生成分享链接
          </Button>
        </div>
        {!enabled && (
          <p className="muted">
            全部条款确认、匹配并复核，且当前没有活动任务后，可生成新分享。已有链接仍可管理。
          </p>
        )}
        {error && <Alert type="error" message={error} showIcon />}
        {loading ? (
          <Spin />
        ) : (
          links.map((link) => {
            const active =
              !link.revoked_at &&
              new Date(link.expires_at).getTime() > Date.now();
            let local = false;
            try {
              local = ["localhost", "127.0.0.1", "[::1]"].includes(
                new URL(link.url).hostname,
              );
            } catch {
              /* Server validates the base URL. */
            }
            return (
              <section className="share-link-card" key={link.id}>
                <header>
                  <Tag color={active ? "success" : "default"}>
                    {active ? "有效" : link.revoked_at ? "已撤销" : "已过期"}
                  </Tag>
                  <small>
                    创建：{new Date(link.created_at).toLocaleString("zh-CN")} ·
                    到期：{new Date(link.expires_at).toLocaleString("zh-CN")}
                  </small>
                </header>
                {active && <CopyLink url={link.url} />}
                {active && local && (
                  <Alert
                    type="warning"
                    message="此链接使用本机地址，同事无法访问。请通过局域网 IP 打开工作台，或配置 PUBLIC_BASE_URL 后重新复制链接。"
                  />
                )}
                {active && (
                  <Popconfirm
                    title="撤销后此链接将无法查看或下载成果，确定撤销？"
                    onConfirm={() => revoke(link.id)}
                  >
                    <Button type="text" danger disabled={busy}>
                      撤销分享
                    </Button>
                  </Popconfirm>
                )}
              </section>
            );
          })
        )}
      </Modal>
    </>
  );
}
