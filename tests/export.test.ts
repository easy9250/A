import { describe, expect, it, vi } from 'vitest';
import {
  buildActionListText,
  exportSnapshot,
  parseSnapshotJson,
  toHtml,
  toJson,
  toMarkdown,
  toPlainText,
} from '@/core/export';
import { safeFileName } from '@/lib/utils';
import { makeSnapshot } from './fixtures';

describe('四格式导出', () => {
  it('Markdown 按标题、元信息、议题、决议、待办、附录的顺序输出', () => {
    const md = toMarkdown(makeSnapshot());

    const positions = [
      md.indexOf('# 产品周会'),
      md.indexOf('**时间**'),
      md.indexOf('**参会人**'),
      md.indexOf('## 议题 1 · 项目进展'),
      md.indexOf('## ✅ 决议'),
      md.indexOf('## 📋 待办事项'),
      md.indexOf('| 内容 | 负责人 | 截止 | 优先级 |'),
      md.indexOf('## 📝 附录：完整发言记录'),
    ];
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(md).toContain('张伟');
    expect(md).toContain('采用方案 B');
    expect(md).toContain('跟进支付接口联调');
  });

  it('Markdown、纯文本、JSON、HTML 都含同一快照的关键业务内容', () => {
    const snapshot = makeSnapshot();
    const outputs = [
      toMarkdown(snapshot),
      toPlainText(snapshot),
      toJson(snapshot),
      toHtml(snapshot),
    ];

    for (const output of outputs) {
      expect(output).toContain('产品周会');
      expect(output).toContain('项目进展');
      expect(output).toContain('采用方案 B');
      expect(output).toContain('跟进支付接口联调');
      expect(output).toContain('张伟');
    }
  });

  it('exportSnapshot 为四种格式生成正确扩展名、MIME 和安全文件名', () => {
    const snapshot = makeSnapshot({ meeting: { ...makeSnapshot().meeting, title: '周会/a:b*?' } });

    for (const format of ['md', 'txt', 'json', 'html'] as const) {
      const payload = exportSnapshot(snapshot, format);
      expect(payload.ext).toBe(format);
      expect(payload.mime).toContain(format === 'md' ? 'markdown' : format === 'txt' ? 'plain' : format);
      expect(payload.fileName).toMatch(new RegExp(`\\.${format}$`));
      expect(payload.fileName).not.toMatch(/[\\/:*?"<>|]/);
    }
  });
});

describe('JSON 导入导出', () => {
  it('toJson → parseSnapshotJson 可无损回读完整数据与 schemaVersion', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 31, 9, 30));
    const snapshot = makeSnapshot();

    const json = toJson(snapshot);
    const parsed = parseSnapshotJson(json);

    expect(parsed).toEqual(JSON.parse(json));
    expect(parsed?.schemaVersion).toBe(snapshot.schemaVersion);
    expect(parsed?.meeting).toEqual(snapshot.meeting);
    expect(parsed?.participants).toEqual(snapshot.participants);
    expect(parsed?.utterances).toEqual(snapshot.utterances);
    vi.useRealTimers();
  });

  it('无效 JSON 或缺少必需 meeting/utterances 时拒绝导入', () => {
    expect(parseSnapshotJson('{')).toBeNull();
    expect(parseSnapshotJson('{"meeting":{}}')).toBeNull();
    expect(parseSnapshotJson('{"utterances":[]}')).toBeNull();
  });
});

describe('打印 HTML 安全与 A4 样式', () => {
  it('包含打印媒体规则与 A4 页尺寸', () => {
    const html = toHtml(makeSnapshot());

    expect(html).toContain('@media print');
    expect(html).toMatch(/@page\s*\{\s*size:A4;/);
  });

  it('会议标题、发言内容中的脚本标签被转义，不能形成可执行标签', () => {
    const attack = '<script>alert(1)</script>';
    const base = makeSnapshot();
    const snapshot = makeSnapshot({
      meeting: { ...base.meeting, title: attack },
      utterances: [{ ...base.utterances[0], text: attack }],
      decisions: [],
      actionItems: [],
    });

    const html = toHtml(snapshot);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('文件名与独立待办清单', () => {
  it('safeFileName 剔除 Windows/Unix 非法字符并提供空名兜底', () => {
    expect(safeFileName('  周会/\\:*?"<>| 2026  ')).toBe('周会 2026');
    expect(safeFileName('/\\:*?"<>|')).toBe('meeting');
  });

  it('md/txt/tsv 三种待办风格包含一致字段并使用各自结构', () => {
    const snapshot = makeSnapshot();
    const md = buildActionListText(snapshot, 'md');
    const txt = buildActionListText(snapshot, 'txt');
    const tsv = buildActionListText(snapshot, 'tsv');

    expect(md).toContain('| 内容 | 负责人 | 截止 | 优先级 | 状态 |');
    expect(md).toContain('| 跟进支付接口联调 | 张伟 |');
    expect(txt).toContain('待办清单 · 产品周会');
    expect(txt).toContain('负责人：张伟');
    expect(tsv.split('\n')[0]).toBe('内容\t负责人\t截止\t优先级\t状态\t来源');
    expect(tsv).toContain('跟进支付接口联调\t张伟\t2026-11-02\tP1\t未完成\t产品周会');
  });
});
