import { describe, expect, it } from 'vitest';
import { parseDueDate, resolveAssignee, resolvePriority, RuleStructurer } from '@/core/struct/RuleStructurer';
import type { Meeting, Participant, Utterance } from '@/types/models';
import { UNKNOWN_SPEAKER_ID } from '@/types/models';

/* ============================================================
 * 这批用例是"补充 + 加严"，重点打负例、判边界、反编造。
 * 所有日期断言都基于固定基准时间，绝不依赖运行当天。
 * ============================================================ */

/** 固定基准：2026-10-30（周五）14:00 本地时间 */
const BASE = new Date(2026, 9, 30, 14, 0, 0, 0).getTime();

const PARTICIPANTS: Participant[] = [
  { id: UNKNOWN_SPEAKER_ID, meetingId: 'm-1', name: '未知发言人', colorIndex: 7, order: -1, createdAt: BASE },
  { id: 'p-zhang', meetingId: 'm-1', name: '张伟', role: '主持人', colorIndex: 0, order: 0, createdAt: BASE },
  { id: 'p-li', meetingId: 'm-1', name: '李娜', colorIndex: 1, order: 1, createdAt: BASE },
  { id: 'p-wang', meetingId: 'm-1', name: '老王', colorIndex: 2, order: 2, createdAt: BASE },
];

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
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
    utteranceCount: 0,
    schemaVersion: 1,
    createdAt: BASE,
    updatedAt: BASE,
    ...overrides,
  };
}

function utt(
  text: string,
  opts: { id?: string; seq?: number; speakerId?: string | null; startMs?: number; endMs?: number } = {},
): Utterance {
  const seq = opts.seq ?? 1;
  const id = opts.id ?? `u-${seq}`;
  const startMs = opts.startMs ?? (seq - 1) * 20_000;
  return {
    id,
    meetingId: 'm-1',
    seq,
    speakerId: opts.speakerId === undefined ? 'p-zhang' : opts.speakerId,
    text,
    startMs,
    endMs: opts.endMs ?? startMs + 6_000,
    source: 'asr',
    isFinal: true,
    starred: false,
    createdAt: BASE + startMs,
  };
}

function rule() {
  return new RuleStructurer();
}

async function run(utterances: Utterance[], participants = PARTICIPANTS) {
  return rule().structure({ meeting: meeting(), participants, utterances });
}

describe('基准时间护栏', () => {
  it('固定基准必须是 2026-10-30 周五，防止用例随时间腐烂', () => {
    const d = new Date(BASE);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(9);
    expect(d.getDate()).toBe(30);
    expect(d.getDay()).toBe(5); // 周五
  });
});

describe('决议：正例与正文清洗', () => {
  it('「我决定…」应剥离句首主语「我」，不原样照搬发言', async () => {
    const r = await run([utt('我决定采用方案 B，明天下午先灰度 5% 的流量', { id: 'u-1', seq: 1 })]);

    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0].content).not.toMatch(/^我/);
    expect(r.decisions[0].content).toContain('采用方案 B');
    expect(r.decisions[0].content).toContain('灰度');
  });

  it('「一致同意…定为 11月3号」完整保留日期信息', async () => {
    const r = await run([utt('我们一致同意把正式发布时间定为 11月3号', { id: 'u-1', seq: 1 })]);

    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0].content).toContain('发布时间定为 11月3号');
  });

  it('「那就按老王说的来」被抽为决议且去掉口语前缀', async () => {
    const r = await run([utt('那就按老王说的来', { id: 'u-1', seq: 1 })]);

    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0].content).toContain('按老王说的来');
  });

  it('溯源指向真实存在的 utterance id', async () => {
    const utterances = [
      utt('我决定采用方案 B', { id: 'u-1', seq: 1 }),
      utt('我们一致同意发布时间定为 11月3号', { id: 'u-2', seq: 2 }),
    ];
    const r = await run(utterances);
    const realIds = new Set(utterances.map((u) => u.id));

    expect(r.decisions.length).toBeGreaterThan(0);
    for (const d of r.decisions) {
      expect(d.sourceUtteranceIds.length).toBeGreaterThan(0);
      d.sourceUtteranceIds.forEach((id) => expect(realIds.has(id)).toBe(true));
    }
  });
});

describe('决议：负例（不得把疑问句/元话语/陈述当决议）', () => {
  it.each([
    ['疑问句·问号', '这个方案是否要再评估一下？'],
    ['疑问句·如何', '灰度节奏到底如何把控，大家怎么看'],
    ['元话语·记下来', '那就这样，决议都记下来了'],
    ['元话语·纪要', '我们总结一下，把纪要发给所有人'],
    ['纯陈述', '当前线上流量保持稳定，没有异常告警'],
  ])('%s 不产生决议', async (_label, text) => {
    const r = await run([utt(text, { id: 'u-neg', seq: 1 })]);
    expect(r.decisions).toEqual([]);
  });

  it('「我确认了确实是…问题」是排查结论，不是决议', async () => {
    const r = await run([utt('我确认了确实是灰度开关配置的问题', { id: 'u-diag', seq: 1 })]);
    expect(r.decisions).toEqual([]);
  });

  it('「由王总决定」这类"决定权在别处/尚未落定"的表述不是决议', async () => {
    const r = await run([utt('这个排期最终由王总决定，我们先不动', { id: 'u-nego', seq: 1 })]);
    expect(r.decisions).toEqual([]);
  });
});

describe('待办：负责人三种来源', () => {
  it('句首「我来」→ 取该条发言的 speakerId', async () => {
    const r = await run([
      utt('我来跟进一下支付接口的联调，下周一前完成', { id: 'u-a1', seq: 1, speakerId: 'p-zhang' }),
    ]);

    expect(r.actionItems).toHaveLength(1);
    const a = r.actionItems[0];
    expect(a.assigneeId).toBe('p-zhang');
    expect(a.dueDate).toBe('2026-11-02'); // 下周一
    expect(a.priority).toBe('P1');
    expect(a.status).toBe('todo');
  });

  it('@提及优先于说话人，且正文洗掉 @姓名/麻烦你 等噪声', async () => {
    const r = await run([
      utt('@李娜 麻烦你安排一下设计评审，尽快，这个优先级最高', {
        id: 'u-a2',
        seq: 1,
        speakerId: 'p-zhang',
      }),
    ]);

    expect(r.actionItems).toHaveLength(1);
    const a = r.actionItems[0];
    expect(a.assigneeId).toBe('p-li'); // 李娜
    expect(a.content).not.toContain('@');
    expect(a.content).not.toContain('李娜 麻烦');
    expect(a.content).not.toMatch(/^麻烦/);
    expect(a.content).toContain('安排');
    expect(a.content).toContain('设计评审');
    expect(a.priority).toBe('P0'); // 尽快
  });

  it('「姓名 + 责任动词」→ 该参会人', async () => {
    const r = await run([
      utt('张伟负责把测试报告发出来，本周内提交', { id: 'u-a3', seq: 1, speakerId: 'p-li' }),
    ]);

    expect(r.actionItems).toHaveLength(1);
    const a = r.actionItems[0];
    expect(a.assigneeId).toBe('p-zhang');
    expect(a.dueDate).toBe('2026-11-01'); // 本周日
  });

  it('句首带口语塞词的「那我来…」仍应把说话人识别为负责人', async () => {
    const r = await run([
      utt('那我来跟进一下支付接口的联调', { id: 'u-a4', seq: 1, speakerId: 'p-zhang' }),
    ]);

    expect(r.actionItems).toHaveLength(1);
    expect(r.actionItems[0].assigneeId).toBe('p-zhang');
  });

  it('未知发言人说「我来」时不得乱猜负责人（保持空）', async () => {
    const r = await run([
      utt('我来跟进一下支付接口的联调', { id: 'u-a5', seq: 1, speakerId: UNKNOWN_SPEAKER_ID }),
    ]);

    expect(r.actionItems).toHaveLength(1);
    expect(r.actionItems[0].assigneeId).toBeNull();
  });

  it('@提及了一个不在参会名单里的人时不得匹配到其他人', async () => {
    const r = await run([
      utt('@设计二组 麻烦你安排一下设计评审', { id: 'u-a6', seq: 1, speakerId: 'p-zhang' }),
    ]);

    const a = r.actionItems[0];
    expect(a).toBeDefined();
    expect(a.assigneeId).not.toBe('p-li');
  });

  it('溯源指向真实 utterance id，且不超出实际发言范围', async () => {
    const utterances = [
      utt('我来跟进一下支付接口的联调，下周一前完成', { id: 'u-s1', seq: 1, speakerId: 'p-zhang' }),
      utt('@李娜 麻烦你安排一下设计评审，尽快', { id: 'u-s2', seq: 2, speakerId: 'p-zhang' }),
      utt('张伟负责把测试报告发出来，本周内提交', { id: 'u-s3', seq: 3, speakerId: 'p-li' }),
    ];
    const r = await run(utterances);
    const realIds = new Set(utterances.map((u) => u.id));

    expect(r.actionItems.length).toBe(3);
    for (const a of r.actionItems) {
      expect(a.sourceUtteranceIds.length).toBeGreaterThan(0);
      a.sourceUtteranceIds.forEach((id) => expect(realIds.has(id)).toBe(true));
    }
  });
});

describe('待办：负例（陈述句不得变成待办）', () => {
  it.each([
    ['已完成陈述·今天', '今天的站会结论我已经同步给大家了'],
    ['已完成陈述·本周', '本周的数据报表李娜已经发出来了'],
    ['已完成陈述·下周', '下周的发版公告我提前发到群里了'],
    ['纯陈述·无时间词', '支付接口目前运行稳定，平均耗时 80 毫秒'],
    ['疑问句', '这份测试报告要不要我再改一版？'],
  ])('%s 不产生待办', async (_label, text) => {
    const r = await run([utt(text, { id: 'u-x', seq: 1, speakerId: 'p-zhang' })]);
    expect(r.actionItems).toEqual([]);
  });
});

describe('DDL 解析（固定基准 2026-10-30 周五）', () => {
  it.each([
    ['明天下午给', '2026-10-31'],
    ['明天完成', '2026-10-31'],
    ['后天完成', '2026-11-01'],
    ['大后天完成', '2026-11-02'],
    ['下周一前完成', '2026-11-02'],
    ['下周完成', '2026-11-08'],
    ['本周内完成', '2026-11-01'],
    ['这周完成', '2026-11-01'],
    ['11月3号完成', '2026-11-03'],
    ['11-03 完成', '2026-11-03'],
    ['11/3 完成', '2026-11-03'],
    ['今天完成', '2026-10-30'],
    ['月底前完成', '2026-10-31'],
    ['本周五前完成', '2026-10-30'],
    ['周三前完成', '2026-11-04'],
  ])('%s → %s', (text, expected) => {
    expect(parseDueDate(text, BASE)).toBe(expected);
  });

  it('无法解析时返回 null，而不是返回今天糊弄过去', () => {
    expect(parseDueDate('有空处理一下', BASE)).toBeNull();
    expect(parseDueDate('尽快推进', BASE)).toBeNull();
    expect(parseDueDate('', BASE)).toBeNull();
  });

  it('不存在的日期（2月30号）不得静默溢出成 3月2号', () => {
    // 2 月没有 30 号。可接受：返回 null（不猜）或夹到 2 月末；
    // 不可接受：溢出到下一个月还伪装成一个合法日期。
    const got = parseDueDate('2月30号上线', BASE);
    const acceptable = got === null || got.startsWith('2026-02') || got.startsWith('2027-02');
    expect(acceptable, `实际返回 ${got}`).toBe(true);
  });

  it('命中的坏档：口语里的数字区间（2-3 周）不得被当成 2月3日 编造假截止日', () => {
    const got = parseDueDate('这个功能上线还要 2-3 周', BASE);
    expect(got).toBeNull();
  });

  it('百分比区间（10-12%）不得被当成 10月12日', () => {
    const got = parseDueDate('Q4 目标是 GMV 增长 10-12%', BASE);
    expect(got).toBeNull();
  });
});

describe('优先级', () => {
  it.each([
    ['尽快', null, 'P0'],
    ['今天必须处理', '2026-10-30', 'P0'],
    ['这个很紧急', null, 'P0'],
    ['明天下班前给我', '2026-10-31', 'P1'],
    ['有日子就行', '2026-12-01', 'P1'],
    ['有空处理一下', null, 'P2'],
  ] as const)('%s + %s → %s', (text, due, expected) => {
    expect(resolvePriority(text, due)).toBe(expected);
  });

  it('无紧急词但有明确日期 → P1（不能默认 P0）', () => {
    expect(resolvePriority('11月3号之前出结论', '2026-11-03')).toBe('P1');
  });
});

describe('负责人识别（单元）', () => {
  it('@提及命中真实参会人', () => {
    expect(resolveAssignee('@李娜 来对接一下', PARTICIPANTS, 'p-zhang')).toBe('p-li');
  });

  it('没有任何线索时返回 null，不猜人', () => {
    expect(resolveAssignee('报告要发一下', PARTICIPANTS, 'p-zhang')).toBeNull();
  });

  it('说话人为 unknown 时不返回 unknown id', () => {
    expect(resolveAssignee('我来跟进', PARTICIPANTS, UNKNOWN_SPEAKER_ID)).toBeNull();
  });
});

describe('议题分段', () => {
  it('间隔恰好 90s 触发新段', async () => {
    const r = await run([
      utt('第一段内容', { id: 'u-1', seq: 1, startMs: 0, endMs: 5_000 }),
      utt('第二段内容', { id: 'u-2', seq: 2, startMs: 95_000, endMs: 100_000 }),
    ]);
    expect(r.topics).toHaveLength(2);
  });

  it('间隔 89s 不切段（注意用中性措辞，避免误命中话题切换词）', async () => {
    const r = await run([
      utt('接口联调已经跑通了', { id: 'u-1', seq: 1, startMs: 0, endMs: 5_000 }),
      utt('压测结果也符合预期', { id: 'u-2', seq: 2, startMs: 94_000, endMs: 99_000 }),
    ]);
    expect(r.topics).toHaveLength(1);
  });

  it('命中切换词但距段首不足 20s 时不切段', async () => {
    const r = await run([
      utt('先回顾登录模块进展', { id: 'u-1', seq: 1, startMs: 0, endMs: 5_000 }),
      utt('接下来我们看一下支付', { id: 'u-2', seq: 2, startMs: 10_000, endMs: 18_000 }),
    ]);
    expect(r.topics).toHaveLength(1);
  });

  it('命中切换词且距段首 ≥20s 时切段', async () => {
    const r = await run([
      utt('先回顾登录模块进展', { id: 'u-1', seq: 1, startMs: 0, endMs: 5_000 }),
      utt('稍等插一句无关的话', { id: 'u-2', seq: 2, startMs: 8_000, endMs: 21_000 }),
      utt('接下来我们看一下发布计划', { id: 'u-3', seq: 3, startMs: 30_000, endMs: 36_000 }),
    ]);
    expect(r.topics).toHaveLength(2);
  });

  it('段的 start/end utteranceId 指向真实发言', async () => {
    const utterances = [
      utt('第一段开始', { id: 'u-1', seq: 1, startMs: 0, endMs: 5_000 }),
      utt('第一段结尾', { id: 'u-2', seq: 2, startMs: 6_000, endMs: 10_000 }),
      utt('第二段开始', { id: 'u-3', seq: 3, startMs: 120_000, endMs: 125_000 }),
    ];
    const r = await run(utterances);
    const ids = new Set(utterances.map((u) => u.id));

    expect(r.topics).toHaveLength(2);
    for (const t of r.topics) {
      if (t.startUtteranceId) expect(ids.has(t.startUtteranceId)).toBe(true);
      if (t.endUtteranceId) expect(ids.has(t.endUtteranceId)).toBe(true);
    }
    expect(r.topics[0].startUtteranceId).toBe('u-1');
    expect(r.topics[0].endUtteranceId).toBe('u-2');
    expect(r.topics[1].startUtteranceId).toBe('u-3');
  });
});

describe('去重与健壮性', () => {
  it('同一语义重复出现合并为一条，并累积溯源', async () => {
    const r = await run([
      utt('我来跟进一下支付接口联调', { id: 'u-r1', seq: 1, speakerId: 'p-zhang' }),
      utt('我来跟进一下支付接口联调', { id: 'u-r2', seq: 2, speakerId: 'p-zhang' }),
    ]);

    expect(r.actionItems).toHaveLength(1);
    expect(r.actionItems[0].sourceUtteranceIds).toEqual(['u-r1', 'u-r2']);
  });

  it('空发言列表不抛错，返回空结果', async () => {
    const r = await run([]);
    expect(r.topics).toEqual([]);
    expect(r.decisions).toEqual([]);
    expect(r.actionItems).toEqual([]);
    expect(r.origin).toBe('rule');
  });

  it('空白/空文本发言被安全跳过', async () => {
    const r = await run([
      utt('   ', { id: 'u-blank', seq: 1 }),
      utt('', { id: 'u-empty', seq: 2 }),
    ]);
    expect(r.decisions).toEqual([]);
    expect(r.actionItems).toEqual([]);
  });

  it('按结构化后的 order 递增且从 0 开始', async () => {
    const r = await run([
      utt('我决定采用方案 B', { id: 'u-1', seq: 1 }),
      utt('我们一致同意发布时间定为 11月3号', { id: 'u-2', seq: 2 }),
    ]);
    expect(r.decisions.map((d) => d.order)).toEqual([0, 1]);
  });

  it('onPartial 被渐进调用且最终产物与中间态一致', async () => {
    const partials: string[] = [];
    const res = await rule().structure(
      { meeting: meeting(), participants: PARTICIPANTS, utterances: [utt('我决定采用方案 B', { id: 'u-1', seq: 1 })] },
      (p) => partials.push(Object.keys(p).sort().join(',')),
    );

    expect(partials.length).toBe(3);
    expect(partials[0]).toContain('topics');
    expect(partials[2]).toContain('actionItems');
    expect(res.decisions).toHaveLength(1);
  });
});
