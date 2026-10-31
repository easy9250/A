import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import CssBaseline from '@mui/material/CssBaseline';
import { StyledEngineProvider, ThemeProvider } from '@mui/material/styles';
import App from './App';
import theme from './theme';
import { useUiStore } from '@/stores/useUiStore';
import './index.css';

/** 全局未捕获错误：转为 toast，绝不白屏 */
window.addEventListener('error', (e) => {
  // eslint-disable-next-line no-console
  console.error('[global error]', e.error ?? e.message);
  useUiStore.getState().toast.error('页面出现异常，请刷新后重试');
});
window.addEventListener('unhandledrejection', (e) => {
  // eslint-disable-next-line no-console
  console.error('[unhandled rejection]', e.reason);
});

const container = document.getElementById('root');
if (!container) throw new Error('#root 挂载点不存在，请检查 index.html');

// 移除首屏骨架
const splash = document.getElementById('boot-splash');
if (splash) splash.remove();

createRoot(container).render(
  <StrictMode>
    {/* ★ injectFirst：让 emotion(MUI) 样式先注入，Tailwind 原子类可覆盖 MUI 自带样式 */}
    <StyledEngineProvider injectFirst>
      <ThemeProvider theme={theme}>
        {/* ★ 归一化统一由 MUI 负责（tailwind preflight 已关闭） */}
        <CssBaseline />
        <App />
      </ThemeProvider>
    </StyledEngineProvider>
  </StrictMode>,
);
