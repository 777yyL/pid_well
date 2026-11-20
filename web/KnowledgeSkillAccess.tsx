import { useState } from "react";
import { Alert, Button, Input, Modal, Popconfirm, Space } from "antd";
import { api, post } from "./api";

export function KnowledgeSkillAccess() {
  const [open, setOpen] = useState(false),
    [token, setToken] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  async function change(revoke: boolean) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (revoke) {
        await api("/knowledge/skill/token", { method: "DELETE" });
        setToken("");
        setNotice("已撤销本账号的只读令牌");
      } else {
        const result = await post<{ token: string }>("/knowledge/skill/token");
        setToken(result.token);
        setNotice("请复制令牌并保存到 Agent 的密钥配置。关闭后无法再次查看。");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button onClick={() => setOpen(true)}>外部 Agent 接入</Button>
      <Modal
        title="销售项知识 Skill"
        open={open}
        footer={null}
        closable={!busy}
        keyboard={!busy}
        maskClosable={!busy}
        onCancel={() => {
          setOpen(false);
          setToken("");
          setNotice("");
          setError("");
        }}
      >
        <ol>
          <li>
            <a href="/api/knowledge/skill/download" download>
              下载 Skill 包
            </a>
            ，解压后将含 SKILL.md 的目录安装到 Agent。
          </li>
          <li>
            在 Agent 的运行环境设置 PINGBIAO_URL 为{" "}
            <code>{location.origin}</code>，将个人只读令牌保存为
            PINGBIAO_TOKEN。
          </li>
          <li>
            试问“哪些产品支持访客预约？请引用销售项原文”。更多命令见包内
            SKILL.md。
          </li>
        </ol>
        <Space wrap>
          {[false, true].map((revoke) => (
            <Popconfirm
              key={String(revoke)}
              title={
                revoke
                  ? "撤销后，使用此令牌的 Agent 将无法查询"
                  : "生成后，本账号旧令牌立即失效"
              }
              onConfirm={() => change(revoke)}
            >
              <Button disabled={busy}>
                {revoke ? "撤销令牌" : "生成只读令牌"}
              </Button>
            </Popconfirm>
          ))}
        </Space>
        {notice && <p role="status">{notice}</p>}
        {token && (
          <Input.Password
            aria-label="个人只读令牌"
            readOnly
            value={token}
            onFocus={(e) => e.target.select()}
          />
        )}
        {error && <Alert type="error" message={error} />}
      </Modal>
    </>
  );
}
