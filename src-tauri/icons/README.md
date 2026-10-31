# 应用图标

Tauri 打包**必须**提供以下图标文件（路径在 `../tauri.conf.json` 的 `bundle.icon` 中声明）：

- `32x32.png`
- `128x128.png`
- `128x128@2x.png`
- `icon.icns`  （macOS）
- `icon.ico`   （Windows）

## 生成方式（推荐）

准备一张 **1024×1024** 的方形 PNG（透明背景最佳），命名为 `logo.png`，放到本目录，
然后执行：

```bash
# 在仓库根目录（meetingmind/）运行
npm run tauri icon src-tauri/icons/logo.png
```

该命令会一次性生成上面列出的全部尺寸 / 格式图标，并覆盖到本目录。

## 不提供图标的后果

跳过此步直接 `tauri build` 会报 “icon not found” 类错误而中断。
开发期 `tauri dev` 同样需要图标存在。

> 也可手动放置符合上述尺寸/格式的文件，只要文件名与 `tauri.conf.json` 中一致即可。
