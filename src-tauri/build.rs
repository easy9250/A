// Tauri 构建脚本：负责收集资源、生成上下文、校验配置。
// 桌面端由 cargo 调用；移动端由 `tauri android/ios` 命令在生成的 gradle/xcode 工程中调用。
fn main() {
    tauri_build::build()
}
