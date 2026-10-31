import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  debounce,
  escapeHtml,
  escapeMd,
  fmtDateTime,
  hhmmss,
  highlightSnippet,
  mmss,
  safeFileName,
  throttle,
  withTimeout,
} from '@/lib/utils';

afterEach(() => {
  vi.useRealTimers();
});

describe('时间与字符串工具', () => {
  it.each([
    [-1, '00:00'],
    [0, '00:00'],
    [61_999, '01:01'],
    [3_661_999, '61:01'],
  ])('mmss(%i) → %s', (input, expected) => {
    expect(mmss(input)).toBe(expected);
  });

  it.each([
    [-1, '00:00:00'],
    [0, '00:00:00'],
    [3_661_999, '01:01:01'],
    [90_061_000, '25:01:01'],
  ])('hhmmss(%i) → %s', (input, expected) => {
    expect(hhmmss(input)).toBe(expected);
  });

  it('fmtDateTime 使用本地年月日时分，并拒绝空值与无效日期', () => {
    const local = new Date(2026, 10, 3, 9, 5).getTime();
    expect(fmtDateTime(local)).toBe('2026-11-03 09:05');
    expect(fmtDateTime(null)).toBe('—');
    expect(fmtDateTime(Number.NaN)).toBe('—');
  });

  it('escapeHtml 转义五类危险字符', () => {
    expect(escapeHtml(`<script x="1">Tom & Jerry's</script>`)).toBe(
      '&lt;script x=&quot;1&quot;&gt;Tom &amp; Jerry&#39;s&lt;/script&gt;',
    );
  });

  it('escapeMd 转义结构字符、表格竖线和行首列表语法', () => {
    expect(escapeMd('- [任务](url) | *紧急*')).toBe('\\- \\[任务\\]\\(url\\) \\| \\*紧急\\*');
    expect(escapeMd('1. 第一项')).toBe('1\\. 第一项');
    expect(escapeMd('第一行\n第二行')).toBe('第一行 第二行');
  });

  it('highlightSnippet 忽略大小写命中、转义原文且只给命中内容加 mark', () => {
    const highlighted = highlightSnippet('前文 <img src=x> MeetingMind 后文', 'meetingmind', 8);
    expect(highlighted).toContain('<mark>MeetingMind</mark>');
    expect(highlighted).toContain('&gt;');
    expect(highlighted).not.toContain('<img');
  });

  it('safeFileName 清理非法字符、截断长度并为空名提供兜底', () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij');
    expect(safeFileName('x'.repeat(100))).toHaveLength(80);
    expect(safeFileName('  ')).toBe('meeting');
  });
});

describe('debounce', () => {
  it('等待窗口内只执行最后一次调用', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const wrapped = debounce(fn, 300);

    wrapped('a');
    vi.advanceTimersByTime(200);
    wrapped('b');
    vi.advanceTimersByTime(299);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('b');
  });

  it('cancel 取消待执行调用，flush 立即执行最后一次', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const wrapped = debounce(fn, 300);

    wrapped('cancelled');
    wrapped.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();

    wrapped('flushed');
    wrapped.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith('flushed');
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('throttle', () => {
  it('首次立即执行，窗口内合并并在尾部执行最后一次', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const fn = vi.fn();
    const wrapped = throttle(fn, 200);

    wrapped('first');
    expect(fn).toHaveBeenCalledWith('first');
    wrapped('middle');
    vi.advanceTimersByTime(100);
    wrapped('last');
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('last');
  });

  it('cancel 取消尾部调用', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const fn = vi.fn();
    const wrapped = throttle(fn, 200);
    wrapped('first');
    wrapped('tail');
    wrapped.cancel();
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('withTimeout', () => {
  it('原 Promise 先完成时返回原值', async () => {
    vi.useFakeTimers();
    const promise = withTimeout(Promise.resolve('ok'), 500, 'fallback');
    await expect(promise).resolves.toBe('ok');
  });

  it('超时分支返回 fallback，原 Promise 后续完成不会改写结果', async () => {
    vi.useFakeTimers();
    let resolveOriginal!: (value: string) => void;
    const original = new Promise<string>((resolve) => {
      resolveOriginal = resolve;
    });
    const result = withTimeout(original, 500, 'fallback');

    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toBe('fallback');
    resolveOriginal('late');
    await Promise.resolve();
    await expect(result).resolves.toBe('fallback');
  });

  it('原 Promise 在超时前拒绝时保留拒绝语义', async () => {
    vi.useFakeTimers();
    const result = withTimeout(Promise.reject(new Error('boom')), 500);
    await expect(result).rejects.toThrow('boom');
  });
});
