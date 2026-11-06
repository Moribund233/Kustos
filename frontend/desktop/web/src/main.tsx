import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/globals.css";
import { App } from "./app";

const container = document.getElementById("root");
if (!container) throw new Error("找不到 #root 挂载点");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
