# MeetingMind 原生应用构建指南（Tauri 2.0）

本目录 `src-tauri/` 是 **Tauri 2.0** 的原生壳配置。它将既有的 React/Vite 前端（`meetingmind/`）
打包为脱离浏览器、点击桌面/手机图标即可启动的独立原生应用，**无需本地服务器、无需 Node 运行时**。

> 方案选择：Tauri 2.0 复用系统 WebView（Windows → WebView2 / macOS → WKWebView / Linux → WebKitGTK /
> Android → Android System WebView / iOS → WKWebView），**不打包 Chromium**，因此产物体积极小（通常 5–15 MB）。

---

## 一、整体项目结构

```
meetingmind/
├─ package.json                 # 前端依赖 + tauri 脚本（tauri / tauri:dev / tauri:build / tauri:icon）
├─ vite.config.ts               # Vite 构建（输出到 dist/，tauri 会读取）
├─ index.html
├─ dist/                        # tauri build 时由 `npm run build` 生成的静态前端
├─ src/                         # 既有 React/Vite 前端（无需为原生壳改写）
│  ├─ lib/platform.ts           # isTauri() / isNativeApp()：区分「原生壳」与「纯浏览器」
│  ├─ features/quick/useQuickSession.ts  # 已做 Tauri 感知的错误提示
│  └─ ...（语音/麦克风/腾讯云 ASR 逻辑均原样复用）
└─ src-tauri/                   # ★ 本目录：原生壳配置（Rust + Tauri）
   ├─ Cargo.toml                # Rust 依赖与产物类型
   ├─ build.rs                  # Tauri 构建脚本
   ├─ tauri.conf.json           # 应用清单：窗口、CSP、各平台打包配置
   ├─ capabilities/default.json # WebView 权限（核心默认即可）
   ├─ src/
   │  ├─ main.rs                # 桌面端入口（win/mac/linux）
   │  └─ lib.rs                 # 真正的 run()：桌面/移动共用
   ├─ icons/                    # 应用图标（需先 `npm run tauri icon` 生成）
   └─ README.md                 # 本文件
```

**应用入口链路**：原生壳启动 → `main.rs`（桌面）/ 移动生成的宿主 → `meetingmind_lib::run()`（lib.rs）
→ Tauri 加载 `dist/` 中的前端 → 系统 WebView 以 `tauri://localhost`（安全上下文）渲染 React 应用。

> 关键点：Tauri 通过 `tauri://localhost` 加载页面，浏览器/WebView 将其视为**安全上下文**，
> 因此前端既有的 `isSecureContext` 判定、`getUserMedia`（麦克风）、Web Audio、WebSocket 逻辑
> **在原生壳内无需任何改动**即可工作（仅错误提示文案已做 Tauri 感知，见 `useQuickSession.ts`）。

---

## 二、前置依赖（只需在构建机上安装）

| 依赖 | 用途 | 安装 |
|------|------|------|
| **Rust 工具链** | 编译原生壳（所有平台都需要） | https://rustup.rs （`rustc`/`cargo`） |
| **Node ≥ 18 + npm** | 构建前端 `dist/` | 已具备 |
| **WebView2** | Windows 运行/构建依赖（Win10/11 通常已自带） | 微软官方运行时 |
| **webkit2gtk** | Linux 构建依赖 | `sudo apt install libwebkit2gtk-4.1-dev`（Ubuntu） |
| **Xcode + Command Line Tools** | **macOS / iOS 构建必需** | App Store 安装 Xcode |
| **Android Studio + SDK/NDK** | **Android 构建必需** | 官方下载，SDK Platform 24+，NDK（Tauri 会提示） |
| **Visual Studio Build Tools** | Windows 构建 Rust 需要 C 编译器 | 安装「C++ 桌面开发」工作负载 |

> ⚠️ **iOS 包（.ipa）只能在 macOS + Xcode 上构建**，无法在 Windows/Linux 出包。
> 其余平台均可在对应系统的构建机上完成。

---

## 三、首次准备

```bash
# 1) 安装 Node 依赖（含 @tauri-apps/cli、@tauri-apps/api）
npm install

# 2) 生成应用图标（准备一张 1024×1024 的 logo.png 放到 src-tauri/icons/）
npm run tauri icon src-tauri/icons/logo.png
#   没有图标直接 build 会失败。生成后会出现 32x32.png / 128x128.png / icon.icns / icon.ico 等。

# 3)（仅移动端首次）生成移动工程骨架
npm run tauri android init     # 生成 src-tauri/gen/android
npm run tauri ios init         # 生成 src-tauri/gen/ios（需 macOS + Xcode）
```

---

## 三·五、用 GitHub Actions 云端构建（★推荐手机用户）

不想在本机装 JDK/Rust/Android SDK？用 CI 让 GitHub 云端出包，你直接用手机浏览器下载安装：

1. 把本仓库推到 GitHub（已包含 `.github/workflows/build-android.yml` 与图标 `src-tauri/icons/logo.png`）。
2. 仓库 → **Actions** → 选择 **Build Android APK** → **Run workflow**（push 到 main/master 也会自动触发）。
3. 跑完后下载 Artifact **`meetingmind-apk`**，里面是 `*.apk`（建议取 `arm64-v8a` 那一个）。
4. 把 `.apk` 传到手机（微信/网盘/二维码），在手机上允许「安装未知应用」即可安装。

> 该工作流已在云端装好 JDK17 + Rust + Android SDK/NDK，`tauri android build` 产出的为可直接侧载的 debug APK。
> 若要上架 Google Play，请改用 `app-release.aab` 并配置签名（参见 Tauri 官方文档）。

---

## 四、各平台构建命令与产物形态

> 所有命令在 `meetingmind/` 根目录执行。产物默认输出到 `src-tauri/target/`（release）。

### 桌面端（Windows / macOS / Linux）

```bash
# 开发调试（热更新，启动原生窗口加载 localhost:5173）
npm run tauri:dev

# 打生产包（同时产出前端 + 原生安装包）
npm run tauri:build
```

| 平台 | 构建命令（等价） | 产物形态 | 安装/运行方式 |
|------|----------------|----------|---------------|
| **Windows** | `tauri build` | `MeetingMind_x.y.z_x64.msi`（WiX，推荐）<br>`MeetingMind_x.y.z_x64-setup.exe`（NSIS，可选） | 双击 `.msi` / `.exe` 安装 |
| **macOS** | `tauri build` | `MeetingMind.app`（应用包）<br>`MeetingMind_x.y.z.dmg`（磁盘镜像，分发推荐）<br>`MeetingMind.pkg`（如需上架/受管分发） | 拖入「应用程序」或挂载 `.dmg` 安装 |
| **Linux** | `tauri build` | `meetingmind_x.y.z_amd64.deb`（Debian/Ubuntu）<br>`meetingmind-x.y.z-1.x86_64.rpm`（Fedora/RHEL）<br>`MeetingMind_x.y.z.AppImage`（免安装可执行） | `dpkg -i *.deb` / `rpm -i *.rpm` / 赋予 `+x` 后双击 `.AppImage` |

> macOS 默认产物为 **Intel (x86_64)**；若要 Apple Silicon 的 `aarch64`，在 Apple 芯片 Mac 上构建，
> 或用 `--target aarch64-apple-darwin` 交叉参数。`.dmg` 已开启（见 `tauri.conf.json` 的 `bundle.macOS.dmg`）。

### 移动端（Android / iOS）

```bash
# Android
npm run tauri android build        # 产物在 src-tauri/gen/android/app/build/outputs/
# iOS（仅 macOS）
npm run tauri ios build            # 产物在 Xcode 的 DerivedData / 归档中
```

| 平台 | 命令 | 产物形态 | 分发方式 |
|------|------|----------|----------|
| **Android** | `tauri android build` | `app-arm64-v8a-release.apk`（直接安装）<br>`app.aab`（Android App Bundle，上架 Google Play 必需） | 设备开启「未知来源」后装 `.apk`；`.aab` 上传 Play 控制台 |
| **iOS** | `tauri ios build` | `MeetingMind.ipa`（需签名） | 通过 Xcode / TestFlight / 企业分发安装（iOS 不支持侧载未签名包） |

> **权限说明**：麦克风权限已在 `tauri.conf.json` 声明——
> Android：`android.permission.RECORD_AUDIO` + `INTERNET`；
> iOS：`NSMicrophoneUsageDescription`（首次使用弹窗说明）+ `UIBackgroundModes: audio`。
> 腾讯云 ASR 的 WebSocket 域名已在 `app.security.csp` 的 `connect-src` 放行。

---

## 五、腾讯云 ASR（国内实时转写）在原生壳中的工作方式

- 前端 `src/core/asr/tencent.ts` 的 HMAC-SHA1 签名走 **Web Crypto**（`crypto.subtle`），
  在 WebView 内正常工作，**无需 Rust 侧参与**。
- `CloudAsrProvider` 通过 `getUserMedia` 取麦克风 → `MediaController.startPcmTap` 抽取 16k/16bit 单声道 PCM
  → 经 **WebSocket（`wss://asr.cloud.tencent.com`）** 实时上送。
- 密钥（SecretId/SecretKey/AppId）由用户在「设置」中填写并**本地保存**（`useUiStore.tencentAsr`），
  或经 `.env` 的 `VITE_TENCENT_ASR_*` 注入，绝不硬编码。

---

## 六、常见问题

- **build 报 icon not found** → 先执行 `npm run tauri icon`（见第三节）。
- **iOS 无法在 Windows 出包** → 必须在 macOS + Xcode 上 `tauri ios build`。
- **麦克风在原生壳里弹不出授权** → 确认 `tauri.conf.json` 中 Android/iOS 权限声明存在；桌面端由系统 WebView 弹窗授权。
- **ASR 连接被拦** → 检查 `app.security.csp` 的 `connect-src` 是否包含 `wss://asr.cloud.tencent.com`。
- **想打开外部链接 / 文件导出落地** → 在 `Cargo.toml` 启用 `tauri-plugin-opener` / `tauri-plugin-dialog`，
  于 `lib.rs` 注册并在 `capabilities/default.json` 增加权限（详见 `Cargo.toml` 注释）。

---

## 七、一句话总结

现有 Web 程序**无需改写**即可成为五端原生应用：用 Tauri 2.0 把 `dist/` 包进系统 WebView，
`tauri build` 一键产出 Windows `.msi/.exe`、macOS `.app/.dmg`、Linux `.deb/.rpm/.AppImage`、
Android `.apk/.aab`、iOS `.ipa`。本环境的机器缺少 Rust/Android/iOS 工具链，**无法在此直接出包**；
请在具备对应 SDK 的构建机上按上述命令生成安装包。
