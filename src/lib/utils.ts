/**
 * 通用工具函数集合。
 * 不依赖任何业务模块，可被任意层引用（也供 core/ 使用）。
 */

/** 生成全局唯一 ID：crypto.randomUUID 优先，非安全上下文回退时间戳+随机串 */
export const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** 两位补零 */
export const pad2 = (n: number): string => String(Math.floor(Math.abs(n))).padStart(2, '0');

/** 毫秒 → `MM:SS`（分钟可超过 59） */
export function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${pad2(m)}:${pad2(s)}`;
}

/** 毫秒 → `HH:MM:SS` */
export function hhmmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/** epoch ms → `YYYY-MM-DD HH:mm`（本地时区） */
export function fmtDateTime(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`;
}

/** epoch ms → `YYYY-MM-DD`（本地时区） */
export function fmtDate(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 毫秒 → 中文时长「1 小时 23 分」/「23 分 45 秒」/「45 秒」 */
export function fmtDurCN(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
  if (m > 0) return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分`;
  return `${s} 秒`;
}

/** 'YYYY-MM-DD' → 相对今天的中文描述（今天 / 明天 / 逾期 N 天 / 还剩 N 天 / M月D日） */
export function relDueDateCN(due?: string | null): string {
  if (!due) return '未设截止';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due.trim());
  if (!m) return due;
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(target.getTime())) return due;
  const today = new Date();
  const a = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diff = Math.round((target.getTime() - a.getTime()) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  if (diff === -1) return '昨天';
  if (diff < 0) return `逾期 ${-diff} 天`;
  if (diff <= 7) return `还剩 ${diff} 天`;
  return `${target.getMonth() + 1}月${target.getDate()}日`;
}

/** HTML 转义：所有用户输入在拼 HTML 字符串前必须经过此函数 */
export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Markdown 转义：只转义真正会破坏结构的字符（不过度转义，保证可读性）。
 * - 反斜杠 / 反引号 / 星号 / 下划线 / 方括号 / 井号 / 波浪线 / 竖线 / 尖括号 / 感叹号 / 圆括号
 * - 行首的 `-`、`+`、`数字.` 单独转义，避免原文被解析成列表
 * - 换行压缩为空格（表格单元格与单行标题场景）
 */
export function escapeMd(s: string): string {
  let out = String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/([`*_[\]()#~|<>!])/g, '\\$1')
    .replace(/\r?\n/g, ' ');
  out = out.replace(/^(\s*)([-+])/, '$1\\$2').replace(/^(\s*)(\d+)\./, '$1$2\\.');
  return out;
}

/**
 * 生成搜索命中片段（已 HTML 转义，命中处包 <mark>…</mark>）。
 * @param text 原文
 * @param keyword 关键词（空则直接取开头）
 * @param radius 命中位置前后保留的字符数
 */
export function highlightSnippet(text: string, keyword?: string, radius = 40): string {
  const raw = sanitizeScan(text);
  const kw = (keyword ?? '').trim();
  if (!kw) {
    const head = raw.slice(0, radius * 2);
    return escapeHtml(head) + (raw.length > radius * 2 ? '…' : '');
  }
  const lower = raw.toLowerCase();
  const idx = lower.indexOf(kw.toLowerCase());
  if (idx < 0) {
    const head = raw.slice(0, radius * 2);
    return escapeHtml(head) + (raw.length > radius * 2 ? '…' : '');
  }
  const start = Math.max(0, idx - radius);
  const end = Math.min(raw.length, idx + kw.length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < raw.length ? '…' : '';
  const before = escapeHtml(raw.slice(start, idx));
  const hit = escapeHtml(raw.slice(idx, idx + kw.length));
  const after = escapeHtml(raw.slice(idx + kw.length, end));
  return `${prefix}${before}<mark>${hit}</mark>${after}${suffix}`;
}

/** 检索文本清洗：去控制字符、压缩空白 */
export function sanitizeScan(s: string): string {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 防抖：wait 毫秒内多次调用只执行最后一次。
 * 返回的函数带 `cancel()` 与 `flush()`。
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  wait = 300,
): ((...args: A) => void) & { cancel: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;
  const wrapped = (...args: A): void => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const a = lastArgs;
      lastArgs = null;
      if (a) fn(...a);
    }, wait);
  };
  wrapped.cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  wrapped.flush = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    const a = lastArgs;
    lastArgs = null;
    if (a) fn(...a);
  };
  return wrapped;
}

/**
 * 节流：wait 毫秒内至多执行一次（首次立即触发，尾部补一次）。
 */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  wait = 200,
): ((...args: A) => void) & { cancel: () => void } {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;
  const wrapped = (...args: A): void => {
    const now = Date.now();
    const remain = wait - (now - last);
    lastArgs = args;
    if (remain <= 0) {
      last = now;
      fn(...args);
      lastArgs = null;
      return;
    }
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        const a = lastArgs;
        lastArgs = null;
        if (a) fn(...a);
      }, remain);
    }
  };
  wrapped.cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  return wrapped;
}

/**
 * 给 Promise 加超时。
 * @param p 原始 Promise
 * @param ms 超时毫秒
 * @param fallback 超时时的返回值（默认 null）
 */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T | null = null): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 文件名安全化：去掉 Windows/Unix 非法字符，最长 80 字符 */
export function safeFileName(name: string): string {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned) || 'meeting';
}

/** 触发浏览器下载（自动 revoke objectURL） */
export function downloadFile(content: string | Blob, fileName: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = typeof content === 'string' ? new Blob([content], { type: mime }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFileName(fileName);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * 复制文本到剪贴板；非安全上下文自动回退 execCommand。
 * @returns 是否成功
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面的兜底方案 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** 按 relMs 生成发言时间码展示文本（如 00:12:34） */
export function timecodeOf(relMs: number): string {
  return hhmmss(relMs);
}
