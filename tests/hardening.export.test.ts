import { describe, expect, it } from 'vitest';
import {
  buildActionListText,
  buildFileName,
  exportSnapshot,
  parseSnapshotJson,
  realParticipants,
  sortActionItems,
  speakerNameOf,
  timecodeOf,
  toHtml,
  toJson,
  toMarkdown,
  toPlainText,
} from '@/core/export';
import type { ActionItem, Decision, MeetingSnapshot, Topic, Utterance } from '@/types/models';
import { SCHEMA_VERSION, UNKNOWN_SPEAKER_ID } from '@/types/models';

/* ============================================================
 * 导出模块加严：XSS 全注入面、JSON 全字段往返、导入校验、表格结构。
 * 全部人工构造 fixture，不依赖他人维护的 fixtures.ts。
 * ============================================================ */

const BASE = new Date(2026, 9, 30, 14, 0, 0, 0).getTime(); // 2026-10-30 周五

const XSS = `<script>alert(1)</script>`;
const XSS2 = `"><img src=x onerror=alert(1)>`;
const XSS3 = `<svg/onload=alert(1)>`;

function baseSnapshot(): MeetingSnapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: BASE,
    meeting: {
      id: 'm-1',
      title: '产品周会',
      ownerId: 'local',
      startedAt: BASE,
      endedAt: BASE + 3_600_000,
      durationMs: 3_600_000,
      status: 'ended',
      mode: 'web-speech',
      lang: 'zh-CN',
      hasAudio: false,
      searchBlob: '',
      utteranceCount: 2,
      schemaVersion: SCHEMA_VERSION,
      createdAt: BASE,
      updatedAt: BASE,
    },
    participants: [
      { id: UNKNOWN_SPEAKER_ID, meetingId: 'm-1', name: '未知发言人', colorIndex: 7, order: -1, createdAt: BASE },
      { id: 'p-zhang', meetingId: 'm-1', name: '张伟', colorIndex: 0, order: 0, createdAt: BASE },
    ],
    utterances: [
      { id: 'u-1', meetingId: 'm-1', seq: 1, speakerId: 'p-zhang', text: '我来跟进支付联调',
        startMs: 131_000, endMs: 137_000, source: 'asr', isFinal: true, starred: false, createdAt: BASE },
      { id: 'u-2', meetingId: 'm-1', seq: 2, speakerId: null, text: '我们一致同意采用方案 B',
        startMs: 200_000, endMs: 208_000, source: 'asr', isFinal: true, starred: false, createdAt: BASE },
    ],
    topics: [{
      id: 't-1', meetingId: 'm-1', order: 0, title: '项目进展', summary: '登录模块完成',
      bullets: ['覆盖率 82%'], startUtteranceId: 'u-1', endUtteranceId: 'u-2',
      origin: 'rule', createdAt: BASE,
    }],
    decisions: [{
      id: 'd-1', meetingId: 'm-1', content: '采用方案 B', sourceUtteranceIds: ['u-2'],
      order: 0, confirmed: false, origin: 'rule', createdAt: BASE,
    }],
    actionItems: [{
      id: 'a-1', meetingId: 'm-1', content: '跟进支付联调', assigneeId: 'p-zhang',
      dueDate: '2026-11-02', priority: 'P1', status: 'todo',
      sourceUtteranceIds: ['u-1'], origin: 'rule', createdAt: BASE,
    }],
  };
}

/** 打印 HTML 模板本身允许出现的标签；出现白名单之外的标签即视为注入成功 */
const ALLOWED_TAGS = new Set([
  '!doctype', 'html', 'head', 'meta', 'title', 'style', 'body', 'div',
  'h1', 'h2', 'h3', 'p', 'ul', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'span',
  '/html', '/head', '/title', '/style', '/body', '/div', '/h1', '/h2', '/h3', '/p',
  '/ul', '/li', '/table', '/thead', '/tbody', '/tr', '/td', '/th', '/span',
]);

/** 取出文档里所有真实标签（已转义的内容不会构成 `<tag` 形态） */
function tagsOf(html: string): string[] {
  return Array.from(html.matchAll(/<([a-zA-Z!/][a-zA-Z0-9/-]*)/g)).map((m) => m[1].toLowerCase());
}

describe('XSS：所有用户输入注入面都必须被转义（HTML 导出）', () => {
  it('标题 / 发言 / 议题 / 决议 / 待办 / 参会人姓名 六个注入面全部失活', () => {
    const s = baseSnapshot();
    const dirty: MeetingSnapshot = {
      ...s,
      meeting: { ...s.meeting, title: XSS },
      participants: [{ ...s.participants[1], name: XSS2 }, s.participants[0]],
      topics: [{ ...s.topics[0], title: XSS3, summary: XSS, bullets: [XSS, XSS2] } as Topic],
      decisions: [{ ...s.decisions[0], content: XSS } as Decision],
      actionItems: [{ ...s.actionItems[0], content: XSS2, dueDate: XSS } as ActionItem],
      utterances: [{ ...s.utterances[0], text: XSS } as Utterance],
    };

    const html = toHtml(dirty);

    // ① 不得出现模板白名单之外的标签
    const unexpected = tagsOf(html).filter((t) => !ALLOWED_TAGS.has(t));
    expect(unexpected, `注入成功的标签：${unexpected.join(', ')}`).toEqual([]);
    // ② 原文必须以转义形态存在
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('导出 HTML 中除文档结构外不含任何可执行标签', () => {
    const html = toHtml(baseSnapshot());
    const unexpected = tagsOf(html).filter((t) => !ALLOWED_TAGS.has(t));
    expect(unexpected).toEqual([]);
  });

  it('Markdown 与纯文本导出同样不会原样吐出可执行标签（ Markdown 渲染器会执行内嵌 HTML）', () => {
    const s = baseSnapshot();
    const dirty: MeetingSnapshot = { ...s, meeting: { ...s.meeting, title: XSS } };
    const md = toMarkdown(dirty);
    const txt = toPlainText(dirty);

    // 「<」必须被反斜杠转义成「\<」，否则渲染器会当成 HTML 标签执行
    // escapeMd 连圆括号一并转义，所以期望串是 \<\script\>\alert\(\1\)\<\/script\>
    expect(md).toContain('\\<script\\>alert\\(1\\)\\</script\\>');
    expect(md).not.toMatch(/(^|[^\\])<script/i);
    expect(txt).toContain(XSS); // 纯文本保留原文是合理的
  });
});

describe('JSON 往返与导入校验', () => {
  it('toJson → parseSnapshotJson 全字段等价（含 topics/decisions/actionItems）', () => {
    const snapshot = baseSnapshot();
    const parsed = parseSnapshotJson(toJson(snapshot));

    expect(parsed).not.toBeNull();
    expect(parsed!.schemaVersion).toBe(SCHEMA_VERSION);
    expect(typeof parsed!.exportedAt).toBe('number');
    expect(parsed!.meeting).toEqual(snapshot.meeting);
    expect(parsed!.participants).toEqual(snapshot.participants);
    expect(parsed!.utterances).toEqual(snapshot.utterances);
    expect(parsed!.topics).toEqual(snapshot.topics);
    expect(parsed!.decisions).toEqual(snapshot.decisions);
    expect(parsed!.actionItems).toEqual(snapshot.actionItems);
  });

  it('toJson 强制写入当前 schemaVersion，忽略入参里的旧值', () => {
    const s = baseSnapshot();
    const json = JSON.parse(toJson({ ...s, schemaVersion: 999 }));
    expect(json.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it.each([
    ['语法非法', '{'],
    ['空对象', '{}'],
    ['缺 meeting', '{"utterances":[]}'],
    ['缺 utterances', '{"meeting":{}}'],
    ['顶层为 null', 'null'],
    ['顶层为数组', '[{"meeting":{},"utterances":[]}]'],
  ])('%s 一律拒绝导入', (_label, raw) => {
    expect(parseSnapshotJson(raw)).toBeNull();
  });

  it('meeting 字段不是对象时不得放行（否则会把字符串塞给 UI）', () => {
    // 期望：拒绝；若实际放行说明类型校验过松
    const got = parseSnapshotJson('{"meeting":"我不是对象","utterances":[]}');
    expect(got === null || typeof got.meeting === 'object').toBe(true);
  });

  it('meeting 缺少核心字段（id/startedAt）时属于脏数据', () => {
    const got = parseSnapshotJson('{"meeting":{"title":"缺字段"},"utterances":[]}');
    expect(got === null || (got.meeting.id !== undefined && got.meeting.startedAt !== undefined)).toBe(true);
  });

  it('缺失的可选数组应补默认值，不能留下 undefined', () => {
    const got = parseSnapshotJson('{"meeting":{"id":"m"},"utterances":[]}');
    expect(got).not.toBeNull();
    expect(got!.topics).toEqual([]);
    expect(got!.decisions).toEqual([]);
    expect(got!.actionItems).toEqual([]);
    expect(got!.participants).toEqual([]);
  });
});

describe('四格式内容一致性与结构', () => {
  it('Markdown 附录行格式为 [HH:MM:SS] 姓名：正文', () => {
    const md = toMarkdown(baseSnapshot());
    expect(md).toContain('[00:02:11] 张伟：我来跟进支付联调');
    expect(md).toContain('[00:03:20] 未知发言人：我们一致同意采用方案 B');
  });

  it('Markdown 待办表格每行恰好 5 个竖线（不被内容撑破）', () => {
    const md = toMarkdown(baseSnapshot());
    const rows = md.split('\n').filter((l) => l.startsWith('|'));
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) {
      expect(row.split('|').length - 1, `坏行：${row}`).toBe(5);
    }
  });

  it('截止日期单元格里的竖线字符会被转义为全角，不破坏 Markdown 表格', () => {
    const s = baseSnapshot();
    const dirty: MeetingSnapshot = {
      ...s,
      actionItems: [{ ...s.actionItems[0], dueDate: 'x|y' } as ActionItem],
    };
    const md = toMarkdown(dirty);
    // 修复后 dueDate 中的 | 被 mdCell 转义为全角 ｜，故此处匹配全角
    const rows = md.split('\n').filter((l) => l.startsWith('|') && l.includes('x｜y'));
    expect(rows).toHaveLength(1);
    // 期望每个表格行仍是 5 个竖线；若 >5 说明 dueDate 未做转义
    expect(rows[0].split('|').length - 1, `实际行：${rows[0]}`).toBe(5);
  });

  it('四种格式都包含标题、议题、决议、待办、发言人姓名', () => {
    const s = baseSnapshot();
    const outputs = [toMarkdown(s), toPlainText(s), toJson(s), toHtml(s)];
    for (const out of outputs) {
      expect(out).toContain('产品周会');
      expect(out).toContain('项目进展');
      expect(out).toContain('覆盖率 82%');
      expect(out).toContain('采用方案 B');
      expect(out).toContain('跟进支付联调');
      expect(out).toContain('张伟');
    }
  });

  it('空快照不抛错：决议/待办/议题显示为空态', () => {
    const s = baseSnapshot();
    const empty: MeetingSnapshot = { ...s, utterances: [], topics: [], decisions: [], actionItems: [] };
    const md = toMarkdown(empty);
    expect(md).toContain('（无）');
    expect(() => toHtml(empty)).not.toThrow();
    expect(() => toPlainText(empty)).not.toThrow();
    expect(() => toJson(empty)).not.toThrow();
  });

  it('未结束的会议导出显示「进行中」而不是崩溃', () => {
    const s = baseSnapshot();
    const live: MeetingSnapshot = { ...s, meeting: { ...s.meeting, endedAt: null } };
    expect(toMarkdown(live)).toContain('进行中');
    expect(toHtml(live)).toContain('进行中');
  });
});

describe('导出编排：扩展名 / MIME / 文件名', () => {
  it.each([
    ['md', 'text/markdown'],
    ['txt', 'text/plain'],
    ['json', 'application/json'],
    ['html', 'text/html'],
  ] as const)('%s → 扩展名与 MIME 正确', (fmt, mime) => {
    const p = exportSnapshot(baseSnapshot(), fmt);
    expect(p.ext).toBe(fmt);
    expect(p.mime).toContain(mime);
    expect(p.fileName).toMatch(new RegExp(`\\.${fmt}$`));
  });

  it('未知格式安全回落到 Markdown', () => {
    const p = exportSnapshot(baseSnapshot(), 'pdf' as never);
    expect(p.ext).toBe('md');
    expect(p.mime).toContain('text/plain');
    expect(p.fileName).toMatch(/\.md$/);
  });

  it('buildFileName 清洗非法字符，纯非法字符时保留日期戳', () => {
    const s = baseSnapshot();
    expect(buildFileName(s.meeting, 'md')).toBe('产品周会_20261030.md');
    expect(buildFileName({ ...s.meeting, title: '/\\:*?"<>|' }, 'md')).toBe('meeting_20261030.md');
    expect(buildFileName({ ...s.meeting, title: '   ' }, 'md')).toBe('meeting_20261030.md');
    expect(buildFileName({ ...s.meeting, title: 'Q3 复盘 / 客户 A|B' }, 'md')).toBe('Q3 复盘 客户 AB_20261030.md');
  });
});

describe('辅助展示函数', () => {
  it('realParticipants 剔除未知发言人', () => {
    expect(realParticipants(baseSnapshot().participants).map((p) => p.id)).toEqual(['p-zhang']);
  });

  it('speakerNameOf 对缺失 / 未知 id 一律回落到「未知发言人」', () => {
    const ps = baseSnapshot().participants;
    expect(speakerNameOf(ps, 'p-zhang')).toBe('张伟');
    expect(speakerNameOf(ps, 'nope')).toBe('未知发言人');
    expect(speakerNameOf(ps, null)).toBe('未知发言人');
    expect(speakerNameOf(ps, undefined)).toBe('未知发言人');
  });

  it('timecodeOf 取首条可用溯源的时间码，全缺失时回落', () => {
    const us = baseSnapshot().utterances;
    expect(timecodeOf(us, ['u-1'])).toBe('00:02:11');
    expect(timecodeOf(us, ['ghost', 'u-2'])).toBe('00:03:20');
    expect(timecodeOf(us, ['ghost'])).toBe('--:--:--');
    expect(timecodeOf(us, [])).toBe('--:--:--');
  });
});

describe('待办清单导出', () => {
  function withItems(items: Partial<ActionItem>[]): MeetingSnapshot {
    const s = baseSnapshot();
    return {
      ...s,
      actionItems: items.map((it, i) => ({
        id: `a-${i}`, meetingId: 'm-1', content: `事项${i}`, assigneeId: 'p-zhang',
        dueDate: '2026-11-02', priority: 'P1' as const, status: 'todo' as const,
        sourceUtteranceIds: ['u-1'], origin: 'rule' as const, createdAt: BASE + i, ...it,
      })),
    };
  }

  it('排序：未完成优先 → P0 优先 → 截止早优先', () => {
    const s = withItems([
      { content: '截止最晚', dueDate: '2026-12-01' },
      { content: '已完成', status: 'done' },
      { content: '无截止', dueDate: null },
      { content: 'P0 紧急', priority: 'P0', dueDate: '2026-12-31' },
      { content: '截止最早', dueDate: '2026-10-31' },
    ]);
    expect(sortActionItems(s.actionItems).map((a) => a.content)).toEqual([
      'P0 紧急', '截止最早', '截止最晚', '无截止', '已完成',
    ]);
  });

  it('三种风格都拿到同一批数据，且各自结构正确', () => {
    const s = withItems([{ content: '内联换行\n和\t制表符' }, { content: '普通事项' }]);
    const md = buildActionListText(s, 'md');
    const txt = buildActionListText(s, 'txt');
    const tsv = buildActionListText(s, 'tsv');

    expect(md.split('\n')[0]).toBe('| 内容 | 负责人 | 截止 | 优先级 | 状态 |');
    expect(md).toContain('普通事项');
    expect(txt).toContain('待办清单 · 产品周会');
    expect(txt).toContain('负责人：张伟');
    expect(tsv.split('\n')[0]).toBe('内容\t负责人\t截止\t优先级\t状态\t来源');
    expect(tsv.split('\n').slice(1)).toHaveLength(2);
  });

  it('tsv 把内容里的换行和制表符替换为空格，保证每行列数一致', () => {
    const s = withItems([{ content: '甲\n乙\t丙' }]);
    const tsv = buildActionListText(s, 'tsv');
    const lines = tsv.split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.split('\t').length, `坏行：${line}`).toBe(6);
    }
  });

  it('md 风格对内容做转义，破坏性字符以 \< \| 形式落地', () => {
    const s = withItems([{ content: 'a|b *粗体* `码`' }]);
    const md = buildActionListText(s, 'md');

    // 竖线、星号、反引号必须被转义，否则渲染时会被当成表格列分隔符 / 强调语法
    expect(md).toContain('a\\|b');
    expect(md).toContain('\\*粗体\\*');
    expect(md).toContain('\\`码\\`');
    // 表头 + 1 条数据（分隔行已被 --- 过滤掉）
    const bodyRows = md.split('\n').filter((l) => l.startsWith('|') && !l.includes('---'));
    expect(bodyRows).toHaveLength(2);
    expect(bodyRows[1]).toContain('a\\|b');
  });

  it('无待办时不抛错', () => {
    const s = baseSnapshot();
    const empty = { ...s, actionItems: [] };
    expect(buildActionListText(empty, 'md')).toContain('| 内容 |');
    expect(buildActionListText(empty, 'tsv')).toBe('内容\t负责人\t截止\t优先级\t状态\t来源');
  });
});
