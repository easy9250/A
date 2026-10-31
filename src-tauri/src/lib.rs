// 应用入口逻辑：桌面与移动端共用。
//
// 说明：
// - 前端（React/Vite）经 `tauri build` 打包进 `dist`，由系统 WebView 加载，
//   地址为 `tauri://localhost`（浏览器视为安全上下文），因此既有的
//   `isSecureContext` 判定、getUserMedia（麦克风）、Web Audio、WebSocket 逻辑
//   在原生壳内**无需改动**即可工作。
// - 腾讯云 ASR 的 WebSocket（wss://asr.cloud.tencent.com）已在 tauri.conf.json 的
//   security.csp → connect-src 中放行，WebView 可直接建立连接。
// - 麦克风权限：桌面端由系统 WebView/系统弹窗授权；移动端权限在
//   bundle.android.permissions / bundle.iOS.infoPlist 中声明（见 tauri.conf.json）。
//
// 如需「打开外部链接 / 文件导出落地」等能力，可在此注册官方插件（见 Cargo.toml 注释），
// 并在 capabilities/default.json 中追加对应权限。

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
