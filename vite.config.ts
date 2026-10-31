import { fileURLToPath, URL } from 'node:url';
// 注意：defineConfig 从 vitest/config 导入 —— 它是 vite 的超集，`vite build` 行为不变。
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Vite 配置。
 * 关键点：
 * 1) `@` 别名指向 src；
 * 2) `@cloudbase/js-sdk` 排除预构建（体积大且为可选依赖，只在运行时动态 import）；
 * 3) 不用 __dirname（ESM 下不存在），改用 import.meta.url。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5173,
    strictPort: false,
  },
  optimizeDeps: {
    exclude: ['@cloudbase/js-sdk'],
    // 预置所有用到的 MUI 子模块，使其在 dev 启动时一次性预构建完成，
    // 避免运行期「发现新依赖」触发重新预构建、进而批量删除旧缓存被安全机制拦截。
    include: [
      // @mui/material 子模块
      '@mui/material/Alert',
      '@mui/material/AppBar',
      '@mui/material/Avatar',
      '@mui/material/Box',
      '@mui/material/Button',
      '@mui/material/Card',
      '@mui/material/CardContent',
      '@mui/material/Checkbox',
      '@mui/material/Chip',
      '@mui/material/CircularProgress',
      '@mui/material/Collapse',
      '@mui/material/CssBaseline',
      '@mui/material/Dialog',
      '@mui/material/DialogActions',
      '@mui/material/DialogContent',
      '@mui/material/DialogContentText',
      '@mui/material/DialogTitle',
      '@mui/material/Divider',
      '@mui/material/Drawer',
      '@mui/material/FormControl',
      '@mui/material/FormControlLabel',
      '@mui/material/IconButton',
      '@mui/material/InputLabel',
      '@mui/material/List',
      '@mui/material/ListItemButton',
      '@mui/material/ListItemIcon',
      '@mui/material/ListItemText',
      '@mui/material/Menu',
      '@mui/material/MenuItem',
      '@mui/material/Paper',
      '@mui/material/Select',
      '@mui/material/Snackbar',
      '@mui/material/Stack',
      '@mui/material/Switch',
      '@mui/material/TextField',
      '@mui/material/ToggleButton',
      '@mui/material/ToggleButtonGroup',
      '@mui/material/Toolbar',
      '@mui/material/Tooltip',
      '@mui/material/Typography',
      '@mui/material/styles',
      // @mui/icons-material 子模块
      '@mui/icons-material/Add',
      '@mui/icons-material/ArrowBack',
      '@mui/icons-material/ArrowDownward',
      '@mui/icons-material/ArrowUpward',
      '@mui/icons-material/Assignment',
      '@mui/icons-material/AutoAwesome',
      '@mui/icons-material/CallMade',
      '@mui/icons-material/CallMerge',
      '@mui/icons-material/CallSplit',
      '@mui/icons-material/Close',
      '@mui/icons-material/Cloud',
      '@mui/icons-material/CloudOff',
      '@mui/icons-material/ContentCopy',
      '@mui/icons-material/DataObject',
      '@mui/icons-material/DeleteOutline',
      '@mui/icons-material/Description',
      '@mui/icons-material/Download',
      '@mui/icons-material/EditNote',
      '@mui/icons-material/ExpandMore',
      '@mui/icons-material/Flag',
      '@mui/icons-material/FiberManualRecord',
      '@mui/icons-material/Gavel',
      '@mui/icons-material/GraphicEq',
      '@mui/icons-material/Groups',
      '@mui/icons-material/HelpOutline',
      '@mui/icons-material/History',
      '@mui/icons-material/Lightbulb',
      '@mui/icons-material/Loop',
      '@mui/icons-material/Menu',
      '@mui/icons-material/Mic',
      '@mui/icons-material/MoreHoriz',
      '@mui/icons-material/MoreVert',
      '@mui/icons-material/NoteAdd',
      '@mui/icons-material/OpenInNew',
      '@mui/icons-material/Pause',
      '@mui/icons-material/Person',
      '@mui/icons-material/PlaylistAddCheck',
      '@mui/icons-material/PlayArrow',
      '@mui/icons-material/RecordVoiceOver',
      '@mui/icons-material/RestartAlt',
      '@mui/icons-material/Schedule',
      '@mui/icons-material/Search',
      '@mui/icons-material/Settings',
      '@mui/icons-material/Star',
      '@mui/icons-material/StarBorder',
      '@mui/icons-material/Stop',
      '@mui/icons-material/Undo',
      '@mui/icons-material/VolumeUp',
      '@mui/icons-material/CheckCircleOutline',
    ],
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // 覆盖 tests/ 目录与就近放置的 src/** 测试
    include: ['tests/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    // 单 worker：并行多 worker 会并发写 vitest 的模块缓存，
    // 在受限沙箱里会触发 EPERM 并被静默跳过部分测试文件（表现为每次跑到的文件数不定）。
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
