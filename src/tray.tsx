/**
 * Entry of the custom tray menu popup (tray.html).
 *
 * A separate tiny React tree rendered in its own borderless webview window
 * anchored to the tray icon. It talks to Rust through two commands
 * (`tray_state`, `tray_action`) and one event (`tray://state`).
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { TrayMenu } from "./layout/TrayMenu.c";
import "./styles.css";

document.documentElement.setAttribute("data-theme", "dark");
// The popup is a transparent window with its own rounded card — the global
// stylesheet paints html/body with the opaque app background, which would
// show as a black box around the corners. Undo exactly that, here only.
document.documentElement.style.background = "transparent";
document.body.style.background = "transparent";
const root = document.getElementById("root");
if (root) root.style.background = "transparent";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TrayMenu />
  </React.StrictMode>
);
