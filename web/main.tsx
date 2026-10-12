import React from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider, App as AntApp } from "antd";
import zhCN from "antd/locale/zh_CN";
import { App } from "./App";
import "./styles.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#28624e",
          colorInfo: "#28624e",
          colorBgLayout: "#f5f6f3",
          colorText: "#1f2937",
          colorTextSecondary: "#526171",
          colorTextTertiary: "#596878",
          colorBorder: "#c2cdc7",
          colorSuccess: "#176b42",
          colorWarning: "#9a5700",
          colorError: "#b42318",
          borderRadius: 7,
          fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
          fontSize: 14,
        },
        components: {
          Button: { primaryShadow: "none" },
          Table: { headerBg: "#f5f6f3" },
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
