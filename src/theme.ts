import { createTheme } from '@mui/material/styles';

/** 品牌主色（深蓝，顶栏与主要按钮） */
export const BRAND_DEEP = '#1E3A8A';
/** 品牌强调色（亮蓝，选中态与主操作） */
export const BRAND_ACCENT = '#2563EB';

/**
 * 发言人配色：Okabe-Ito 色觉友好 8 色（按色觉障碍友好顺序排列）。
 * 与 Participant.colorIndex 一一对应，创建后不再变动。
 */
export const SPEAKER_COLORS: string[] = [
  '#E69F00', // 橙
  '#56B4E9', // 天蓝
  '#009E73', // 绿
  '#0072B2', // 深蓝
  '#D55E00', // 朱红
  '#CC79A7', // 紫粉
  '#F0E442', // 黄
  '#7D7D7D', // 灰（同时作为「未知发言人」色）
];

/** 取第 i 位发言人的颜色（对负数与超界做安全取模） */
export const speakerColor = (i: number): string =>
  SPEAKER_COLORS[(((Number(i) || 0) % SPEAKER_COLORS.length) + SPEAKER_COLORS.length) % SPEAKER_COLORS.length];

/** 中文字体栈 */
const FONT_STACK = [
  '-apple-system',
  'BlinkMacSystemFont',
  '"Segoe UI"',
  '"PingFang SC"',
  '"Hiragino Sans GB"',
  '"Microsoft YaHei"',
  '"Helvetica Neue"',
  'Arial',
  'sans-serif',
].join(',');

const theme = createTheme({
  palette: {
    primary: {
      main: BRAND_DEEP,
      light: BRAND_ACCENT,
      dark: '#152C6B',
      contrastText: '#FFFFFF',
    },
    secondary: {
      main: BRAND_ACCENT,
      contrastText: '#FFFFFF',
    },
    success: { main: '#009E73' },
    warning: { main: '#E69F00' },
    error: { main: '#D55E00' },
    background: {
      default: '#F5F7FB',
      paper: '#FFFFFF',
    },
    text: {
      primary: '#1F2937',
      secondary: '#6B7280',
    },
  },
  shape: { borderRadius: 10 },
  spacing: 8,
  typography: {
    fontFamily: FONT_STACK,
    h6: { fontWeight: 600, fontSize: '1.05rem' },
    subtitle2: { fontWeight: 600 },
    body2: { lineHeight: 1.6 },
    button: { textTransform: 'none', fontWeight: 600 },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: '#F5F7FB',
          WebkitFontSmoothing: 'antialiased',
        },
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: { root: { borderRadius: 8 } },
    },
    MuiChip: {
      styleOverrides: { root: { borderRadius: 6, fontWeight: 600 } },
    },
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: { root: { backgroundImage: 'none' } },
    },
    MuiTooltip: {
      defaultProps: { arrow: true },
    },
  },
});

export default theme;
