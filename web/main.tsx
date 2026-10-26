import React from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider, App as AntApp } from "antd";
import zhCN from "antd/locale/zh_CN";
import { App } from "./App";
import "./styles.css";
import "./theme.css";
import "./chat.css";
document.documentElement.removeAttribute("data-theme");
localStorage.removeItem("workspace.theme");
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#326fd1",
          colorInfo: "#326fd1",
          colorBgLayout: "#f6f8fb",
          colorBgContainer: "#ffffff",
          colorBgElevated: "#ffffff",
          colorLink: "#326fd1",
          colorText: "#1f2937",
          colorTextSecondary: "#526171",
          colorTextTertiary: "#596878",
          colorBorder: "#dce3ed",
          colorSuccess: "#176b42",
          colorWarning: "#9a5700",
          colorError: "#b42318",
          borderRadius: 9,
          fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
          fontSize: 14,
        },
        components: {
          Button: { primaryShadow: "none" },
          Table: { headerBg: "#f7f9fc" },
          Tabs: { horizontalItemGutter: 22 },
        },
      }}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
