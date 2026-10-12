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
          colorText: "#25352f",
          colorBorder: "#dfe5de",
          borderRadius: 7,
          fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
          fontSize: 13,
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
