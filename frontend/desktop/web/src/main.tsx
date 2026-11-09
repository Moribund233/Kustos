import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/globals.css";
// 在 App 之前初始化 i18n：资源是同步加载的（见 lib/i18n/index.ts），
// 因此首帧就是正确语言，用户看不到语言闪变。
import "./lib/i18n";
import { App } from "./app";

const container = document.getElementById("root");
if (!container) throw new Error("找不到 #root 挂载点");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
