import { describe, it, expect } from 'vitest';
import { computeSessionStats } from '@/features/quick/stats';
import type { SessionEntry } from '@/features/quick/types';
import type { StructResult } from '@/core/struct';

const struct: StructResult = {
  topics: [{ id: 't1', meetingId: 'm', order: 0, title: '议题一', bullets: ['要点'], origin: 'rule' }],
  decisions: [{ id: 'd1', meetingId: 'm', content: '决议一', sourceUtteranceIds: [], order: 0, confirmed: false, origin: 'rule' }],
  actionItems: [
    { id: 'a1', meetingId: 'm', content: '待办一', priority: 'P1', status: 'todo', sourceUtteranceIds: [], origin: 'rule' },
    { id: 'a2', meetingId: 'm', content: '待办二', priority: 'P2', status: 'done', sourceUtteranceIds: [], origin: 'rule' },
  ],
  origin: 'rule',
};

const entries: SessionEntry[] = [
  { id: 'v1', kind: 'voice', text: '会议开始了', relMs: 0, createdAt: 1, source: 'asr' },
  { id: 'n1', kind: 'note', text: '重点一', relMs: 5000, createdAt: 2 },
  { id: 'v2', kind: 'voice', text: '我们决定采用方案B', relMs: 10000, createdAt: 3, source: 'asr' },
];

describe('computeSessionStats', () => {
  it('统计时长、笔记、语音与结构化计数', () => {
    const stats = computeSessionStats({ startedAt: 0, endedAt: 120000, entries, struct, hasAudio: true });
    expect(stats.durationMs).toBe(120000);
    expect(stats.noteCount).toBe(1);
    expect(stats.noteChars).toBe('重点一'.length);
    expect(stats.voiceSegments).toBe(2);
    expect(stats.voiceChars).toBe(('会议开始了' + '我们决定采用方案B').length);
    expect(stats.entryCount).toBe(3);
    expect(stats.topicCount).toBe(1);
    expect(stats.decisionCount).toBe(1);
    expect(stats.actionCount).toBe(2);
    expect(stats.openActionCount).toBe(1);
  });

  it('endedAt 为 null 时时长归零、计数为空', () => {
    const stats = computeSessionStats({ startedAt: 0, endedAt: null, entries: [], struct, hasAudio: false });
    expect(stats.durationMs).toBe(0);
    expect(stats.entryCount).toBe(0);
    expect(stats.noteCount).toBe(0);
  });
});
