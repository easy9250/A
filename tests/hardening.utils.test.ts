import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  debounce,
  escapeHtml,
  escapeMd,
  fmtDate,
  fmtDateTime,
  fmtDurCN,
  highlightSnippet,
  hhmmss,
  mmss,
  newId,
  pad2,
  relDueDateCN,
  sanitizeScan,
  throttle,
  withTimeout,
} from '@/lib/utils';

/* ============================================================
 * 工具函数加严：
 * 1) 凡是依赖「今天」的函数一律冻结系统时间，禁止用例随时间腐烂；
 * 2) debounce/throttle 补足取消后复用、跨窗口边界等语义；
 * 3) withTimeout 覆盖成功 / 超时 / 拒绝 / 超时后迟到的拒绝 四条路径。
 * ============================================================ */

afterEach(() => {
  vi.useRealTimers();
});

/** 冻结到 2026-10-30（周五）14:00 本地时间 */
function freezeToday(): number {
  const t = new Date(2026, 9, 30, 14, 0, 0, 0).getTime();
  vi.useFakeTimers();
  vi.setSystemTime(t);
  return t;
}

describe('时间格式化：跨天 / 边界 / 非法值', () => {
  it.each([
    [-1, '1970-01-01 07:59'],
    [Number.NaN, '—'],
    [null, '—'],
    [undefined, '—'],
    [Number.POSITIVE_INFINITY, '—'],
  ])('fmtDateTime(%o) → %s', (input, expected) => {
    expect(fmtDateTime(input)).toBe(expected);
  });

  it('时间码 0 是一个合法 epoch，不能被当成空值吞掉', () => {
    // 源码 `if (!ms) return '—'` 把 0 / 1970 纪元判成了无值
    expect(fmtDateTime(0)).toBe('1970-01-01 08:00');
    expect(fmtDate(0)).toBe('1970-01-01');
  });

  it('fmtDateTime 跨 24 点与时区无关地走本地时区', () => {
    expect(fmtDateTime(new Date(2026, 11, 31, 23, 59).getTime())).toBe('2026-12-31 23:59');
    expect(fmtDate(new Date(2026, 0, 1, 0, 0).getTime())).toBe('2026-01-01');
    expect(fmtDate(null)).toBe('—');
    expect(fmtDate(Number.NaN)).toBe('—');
  });

  it('fmtDurCN 覆盖小时 / 分 / 秒三档与零值负值', () => {
    expect(fmtDurCN(0)).toBe('0 秒');
    expect(fmtDurCN(-5_000)).toBe('0 秒');
    expect(fmtDurCN(45_000)).toBe('45 秒');
    expect(fmtDurCN(60_000)).toBe('1 分');
    expect(fmtDurCN(83_000)).toBe('1 分 23 秒');
    expect(fmtDurCN(3_600_000)).toBe('1 小时');
    expect(fmtDurCN(4_980_000)).toBe('1 小时 23 分');
    expect(fmtDurCN(25 * 3_600_000)).toBe('25 小时');
  });

  it('pad2 处理负数与多位数字', () => {
    expect(pad2(7)).toBe('07');
    expect(pad2(-7)).toBe('07');
    expect(pad2(123)).toBe('123');
  });

  it('hhmmss 越过 24 小时不清零（长时间会议必须能看完整时长）', () => {
    expect(hhmmss(25 * 3_600_000)).toBe('25:00:00');
    expect(hhmmss(99 * 3_600_000 + 61_000)).toBe('99:01:01');
    expect(mmss(61 * 60_000)).toBe('61:00');
  });
});

describe('relDueDateCN（冻结到 2026-10-30）', () => {
  it.each([
    ['2026-10-30', '今天'],
    ['2026-10-31', '明天'],
    ['2026-11-01', '后天'],
    ['2026-10-29', '昨天'],
    ['2026-10-25', '逾期 5 天'],
    ['2026-11-05', '还剩 6 天'],
    ['2026-11-06', '还剩 7 天'],
    ['2026-12-10', '12月10日'],
  ])('%s → %s', (due, expected) => {
    freezeToday();
    expect(relDueDateCN(due)).toBe(expected);
  });

  it('空值与格式非法时的兜底', () => {
    freezeToday();
    expect(relDueDateCN('')).toBe('未设截止');
    expect(relDueDateCN(null)).toBe('未设截止');
    expect(relDueDateCN(undefined)).toBe('未设截止');
    expect(relDueDateCN('2026-1-5')).toBe('2026-1-5'); // 非法格式原样返回
    expect(relDueDateCN('不是日期')).toBe('不是日期');
  });

  it('带空格/前后空白的合法日期能容错', () => {
    freezeToday();
    expect(relDueDateCN(' 2026-10-31 ')).toBe('明天');
  });
});

describe('sanitizeScan 与 highlightSnippet', () => {
  it('sanitizeScan 去控制字符并压缩空白', () => {
    expect(sanitizeScan('a\u0000b\n\t  c\u007fd')).toBe('a b c d');
    expect(sanitizeScan('  前后留白  ')).toBe('前后留白');
    expect(sanitizeScan(null as never)).toBe('');
  });

  it('无关键词时取开头并在超长时补省略号', () => {
    const short = highlightSnippet('短文本');
    expect(short).toBe('短文本');

    const long = '一'.repeat(200);
    const out = highlightSnippet(long);
    expect(out).toHaveLength(81); // 80 字 + 省略号
    expect(out.endsWith('…')).toBe(true);
  });

  it('关键词未命中时同样走「取开头」分支', () => {
    expect(highlightSnippet('甲乙丙丁', '戊')).toBe('甲乙丙丁');
  });

  it('命中在开头时不加前置省略号，超出尾部时加后置省略号', () => {
    const head = highlightSnippet('关键词开头的句子后面还有很多很多很多很多内容', '关键词', 4);
    expect(head).not.toMatch(/^…/);
    expect(head).toContain('<mark>关键词</mark>');

    const tail = highlightSnippet('前面有很多很多很多很多内容然后是关键词', '关键词', 4);
    expect(tail.startsWith('…')).toBe(true);
    expect(tail).not.toContain('前面有很多');
  });

  it('命中内容做 HTML 转义，且只有命中处包 <mark>', () => {
    const out = highlightSnippet('前缀 <img src=x onerror=alert(1)> 后缀', 'onerror', 30);
    expect(out).toContain('&lt;img');
    expect(out).toContain('<mark>onerror</mark>');
    expect(out).not.toContain('<img');
    expect(out.match(/<mark>/g)).toHaveLength(1);
  });

  it('关键词大小写不敏感，但回显的是原文大小写', () => {
    expect(highlightSnippet('MeetingMind 会议', 'meetingmind')).toContain('<mark>MeetingMind</mark>');
  });

  it('空文本与空关键词不抛错', () => {
    expect(highlightSnippet('')).toBe('');
    expect(highlightSnippet('', 'x')).toBe('');
    expect(highlightSnippet('abc', '   ')).toBe('abc');
  });
});

describe('转义函数', () => {
  it('escapeHtml 对空/非字符串输入做兜底', () => {
    expect(escapeHtml(null as never)).toBe('');
    expect(escapeHtml(undefined as never)).toBe('');
    expect(escapeHtml(123 as never)).toBe('123');
  });

  it('escapeHtml 转义后不可能还原出可执行标签', () => {
    const evil = `<script>alert('x')</script><img src=1 onerror=alert(1)>`;
    const out = escapeHtml(evil);
    expect(out).not.toMatch(/</);
    expect(out).not.toMatch(/>/);
    expect(out).not.toMatch(/'/);
    expect(out).not.toMatch(/"/);
    expect(out).toBe(
      '&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&lt;img src=1 onerror=alert(1)&gt;',
    );
  });

  it('escapeMd 对换行、缩进列表、表格竖线逐一处理', () => {
    expect(escapeMd('a\r\nb')).toBe('a b');
    expect(escapeMd('  - 缩进列表')).toBe('  \\- 缩进列表');
    expect(escapeMd('+ 加号列表')).toBe('\\+ 加号列表');
    expect(escapeMd('12. 有序')).toBe('12\\. 有序');
    expect(escapeMd('a|b')).toBe('a\\|b');
    expect(escapeMd('')).toBe('');
    expect(escapeMd(null as never)).toBe('');
  });

  it('escapeMd 串行转义反斜杠，避免又被当成转义符吃掉', () => {
    expect(escapeMd('a\\b')).toBe('a\\\\b');
  });
});

describe('newId', () => {
  it('连续生成 1000 个 ID 互不重复', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000);
  });

  it('ID 均为非空字符串且不含空白', () => {
    for (const id of Array.from({ length: 20 }, () => newId())) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
      expect(id).not.toMatch(/\s/);
    }
  });
});

describe('debounce 补充语义', () => {
  it('cancel 后仍可继续使用（僵尸状态检测）', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const wrapped = debounce(fn, 100);

    wrapped('a');
    wrapped.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();

    wrapped('b');
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith('b');
  });

  it('flush 后不再重复触发（不会泄漏第二次调用）', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const wrapped = debounce(fn, 100);

    wrapped('once');
    wrapped.flush();
    wrapped.flush(); // 二次 flush 不应再补一刀
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('未调用过就 cancel / flush 是安全的空操作', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const wrapped = debounce(fn, 100);

    expect(() => wrapped.cancel()).not.toThrow();
    expect(() => wrapped.flush()).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it('多次调用只认最后一次的参数', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const wrapped = debounce(fn, 100);

    wrapped('1');
    wrapped('2');
    wrapped('3');
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('3');
  });
});

describe('throttle 补充语义', () => {
  it('窗口内多次调用最终只补一次尾部调用', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const fn = vi.fn();
    const wrapped = throttle(fn, 200);

    wrapped('1');
    for (let i = 2; i <= 6; i += 1) wrapped(String(i));
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('6');
  });

  it('跨窗口后下一次调用立即执行', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const fn = vi.fn();
    const wrapped = throttle(fn, 200);

    wrapped('first');
    vi.advanceTimersByTime(250);
    wrapped('after-window');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('after-window');
  });

  it('cancel 之后仍可正常再触发', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const fn = vi.fn();
    const wrapped = throttle(fn, 200);

    wrapped('a');
    wrapped('b');
    wrapped.cancel();
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);

    wrapped('c');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('c');
  });

  it('未调用过就 cancel 不抛错', () => {
    vi.useFakeTimers();
    const wrapped = throttle(() => {}, 200);
    expect(() => wrapped.cancel()).not.toThrow();
  });
});

describe('withTimeout 四条路径', () => {
  it('① 成功路径返回原值', async () => {
    const r = await withTimeout(Promise.resolve('ok'), 100, 'fb');
    expect(r).toBe('ok');
  });

  it('② 超时路径返回 fallback', async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise<string>(() => {}), 100, 'fb');
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBe('fb');
  });

  it('③ 拒绝路径保留 rejection（且不被 fallback 吞掉）', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 100, 'fb')).rejects.toThrow('boom');
  });

  it('④ 已超时后原 Promise 迟到的拒绝不得再污染调用方', async () => {
    vi.useFakeTimers();
    let rejectLater!: (e: Error) => void;
    const original = new Promise<string>((_res, rej) => {
      rejectLater = rej;
    });

    const p = withTimeout(original, 100, 'fb');
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBe('fb');

    rejectLater(new Error('迟到的拒绝'));
    await Promise.resolve();
    await Promise.resolve();
    await expect(p).resolves.toBe('fb');
  });

  it('⑤ 不传 fallback 时超时返回 null', async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise<string>(() => {}), 50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(p).resolves.toBeNull();
  });
});
