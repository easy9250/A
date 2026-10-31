// 桌面端入口（Windows / macOS / Linux）。
// 发布版隐藏控制台窗口（仅 Windows 生效）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 实际逻辑在 lib.rs 的 run()，桌面与移动共用。
    meetingmind_lib::run();
}
