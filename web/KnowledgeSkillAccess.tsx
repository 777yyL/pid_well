import { useState } from "react";
import { Button, Modal } from "antd";

export function KnowledgeSkillAccess() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>外部 Agent 接入</Button>
      <Modal
        title="销售项知识 Skill"
        open={open}
        footer={null}
        onCancel={() => setOpen(false)}
      >
        <p><a href="/api/knowledge/skill/download" download>下载 Skill 包</a>，解压并安装到 Agent。</p>
        <p>服务地址固定为 http://10.1.219.160:4317，无需配置地址或 API Key。运行 Agent 的机器须能访问该内网地址。</p>
      </Modal>
    </>
  );
}
