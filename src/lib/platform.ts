/**
 * 运行环境探测。
 *
 * 打包为 Tauri 原生应用后，前端代码仍运行在系统 WebView 中（不是浏览器、也不是 iframe）。
 * Tauri 注入 `window.__TAURI_INTERNALS__`，借此区分「原生壳」与「纯浏览器」。
 *
 * 注意：Tauri 通过 `tauri://localhost` 加载页面，浏览器将其视为**安全上下文**，
 * 因此应用内既有的 `isSecureContext` 判定与麦克风 / WebSocket 逻辑无需改动即可在原生壳内工作。
 */
export function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
}

/** 是否为独立原生应用（桌面 exe/app 或移动端 app） */
export function isNativeApp(): boolean {
  return isTauri();
}
