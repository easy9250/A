import { describe, expect, it } from 'vitest';
import { parseDueDate, resolvePriority, RuleStructurer } from '@/core/struct/RuleStructurer';
import type { Participant, Utterance } from '@/types/models';
import { BASE_DATE, makeMeeting, makeParticipant, makeUtterance } from './fixtures';

const participants: Participant[] = [
  makeParticipant('unknown', '未知发言人', -1, { role: 'system' }),
  makeParticipant('p-zhang', '张伟', 0),
  makeParticipant('p-li', '李娜', 1),
  makeParticipant('p-wang', '老王', 2),
];

async function structure(utterances: Utterance[]) {
  return new RuleStructurer().structure({
    meeting: makeMeeting({ status: 'ended', startedAt: BASE_DATE }),
    participants,
    utterances,
  });
}

describe('RuleStructurer 决议抽取', () => {
  it('从真实中文会议句式中抽取三类决议并保留真实溯源', async () => {
    const utterances = [
      makeUtterance('u-1', 1, '我决定采用方案 B，明天下午先灰度 5%', { speakerId: 'p-zhang' }),
      makeUtterance('u-2', 2, '我们一致同意把发布时间定为 11月3号', { speakerId: 'p-li' }),
      makeUtterance('u-3', 3, '那就按老王说的来', { speakerId: 'p-zhang' }),
    ];

    const result = await structure(utterances);

    expect(result.decisions).toHaveLength(3);
    expect(result.decisions.map((d) => d.content).join('\n')).toContain('采用方案 B');
    expect(result.decisions.map((d) => d.content).join('\n')).toContain('发布时间定为 11月3号');
    expect(result.decisions.map((d) => d.content).join('\n')).toContain('按老王说的来');
    const realIds = new Set(utterances.map((u) => u.id));
    for (const decision of result.decisions) {
      expect(decision.sourceUtteranceIds.length).toBeGreaterThan(0);
      expect(decision.sourceUtteranceIds.every((id) => realIds.has(id))).toBe(true);
    }
  });

  it('拒绝疑问句和记录纪要的元话语', async () => {
    const result = await structure([
      makeUtterance('u-q', 1, '这个方案是否要再评估一下？'),
      makeUtterance('u-meta', 2, '那就这样，决议都记下来了'),
      makeUtterance('u-plain', 3, '当前线上流量保持稳定'),
    ]);

    expect(result.decisions).toEqual([]);
  });

  it('同一决议重复出现时只产出一条并合并溯源', async () => {
    const result = await structure([
      makeUtterance('u-d1', 1, '我们一致同意采用方案 B'),
      makeUtterance('u-d2', 2, '我们一致同意采用方案 B'),
    ]);

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].sourceUtteranceIds).toEqual(['u-d1', 'u-d2']);
  });
});

describe('RuleStructurer 待办抽取', () => {
  it('识别“我来”、@提及、姓名责任动词三种负责人写法', async () => {
    const utterances = [
      makeUtterance('u-a1', 1, '我来跟进支付接口联调，下周一前完成', { speakerId: 'p-zhang' }),
      makeUtterance('u-a2', 2, '@李娜 麻烦你安排一下设计评审，尽快', { speakerId: 'p-zhang' }),
      makeUtterance('u-a3', 3, '张伟负责把测试报告发出来，本周内', { speakerId: 'p-li' }),
    ];

    const result = await structure(utterances);

    expect(result.actionItems).toHaveLength(3);
    const bySource = new Map(result.actionItems.map((a) => [a.sourceUtteranceIds[0], a]));
    expect(bySource.get('u-a1')?.assigneeId).toBe('p-zhang');
    expect(bySource.get('u-a1')?.dueDate).toBe('2026-11-02');
    expect(bySource.get('u-a1')?.priority).toBe('P1');
    expect(bySource.get('u-a2')?.assigneeId).toBe('p-li');
    expect(bySource.get('u-a2')?.priority).toBe('P0');
    expect(bySource.get('u-a3')?.assigneeId).toBe('p-zhang');
    expect(bySource.get('u-a3')?.dueDate).toBe('2026-11-01');
    const realIds = new Set(utterances.map((u) => u.id));
    expect(result.actionItems.every((a) => a.sourceUtteranceIds.every((id) => realIds.has(id)))).toBe(true);
  });

  it('纯陈述即使包含普通动词也不进入待办', async () => {
    const result = await structure([
      makeUtterance('u-p1', 1, '测试报告已经发出来了'),
      makeUtterance('u-p2', 2, '支付接口目前运行稳定'),
    ]);

    expect(result.actionItems).toEqual([]);
  });

  it('同一待办重复出现时只产出一条并合并溯源', async () => {
    const result = await structure([
      makeUtterance('u-a1', 1, '我来跟进支付接口联调，下周一前完成', { speakerId: 'p-zhang' }),
      makeUtterance('u-a2', 2, '我来跟进支付接口联调，下周一前完成', { speakerId: 'p-zhang' }),
    ]);

    expect(result.actionItems).toHaveLength(1);
    expect(result.actionItems[0].sourceUtteranceIds).toEqual(['u-a1', 'u-a2']);
  });
});

describe('RuleStructurer 日期、优先级与议题分段', () => {
  it.each([
    ['明天完成', '2026-10-31'],
    ['后天完成', '2026-11-01'],
    ['下周一前完成', '2026-11-02'],
    ['下周完成', '2026-11-08'],
    ['11月3号完成', '2026-11-03'],
    ['11-03 完成', '2026-11-03'],
    ['本周内完成', '2026-11-01'],
  ])('以固定会议开始时间解析 %s', (text, expected) => {
    expect(parseDueDate(text, BASE_DATE)).toBe(expected);
  });

  it.each([
    ['请尽快完成', null, 'P0'],
    ['今天完成', '2026-10-30', 'P0'],
    ['这是紧急事项', null, 'P0'],
    ['11月3号完成', '2026-11-03', 'P1'],
    ['有空处理一下', null, 'P2'],
  ] as const)('优先级规则：%s → %s', (text, dueDate, expected) => {
    expect(resolvePriority(text, dueDate)).toBe(expected);
  });

  it('90 秒间隔和话题切换词都能触发新议题', async () => {
    const result = await structure([
      makeUtterance('u-t1', 1, '先回顾登录模块进展', { startMs: 0, endMs: 5_000 }),
      makeUtterance('u-t2', 2, '支付接口目前完成联调', { startMs: 95_000, endMs: 100_000 }),
      makeUtterance('u-t3', 3, '接下来我们看一下发布计划', { startMs: 125_000, endMs: 130_000 }),
    ]);

    expect(result.topics).toHaveLength(3);
    expect(result.topics.map((t) => t.startUtteranceId)).toEqual(['u-t1', 'u-t2', 'u-t3']);
    expect(result.topics.map((t) => t.endUtteranceId)).toEqual(['u-t1', 'u-t2', 'u-t3']);
  });
});
