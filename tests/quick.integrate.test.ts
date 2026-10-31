import { describe, it, expect } from 'vitest';
import { buildSnapshot, mergeEntriesToUtterances, NOTE_SPEAKER_ID, NOTE_SPEAKER_NAME } from '@/features/quick/integrate';
import type { SessionEntry } from '@/features/quick/types';
import type { StructResult } from '@/core/struct';

const entries: SessionEntry[] = [
  { id: 'v1', kind: 'voice', text: '语音A', relMs: 10000, createdAt: 1, source: 'asr' },
  { id: 'n1', kind: 'note', text: '笔记B', relMs: 2000, createdAt: 2 },
  { id: 'v2', kind: 'voice', text: '语音C', relMs: 5000, createdAt: 3, source: 'manual' },
];

const struct: StructResult = {
  topics: [{ id: 't', meetingId: 'm', order: 0, title: '议题', bullets: [], origin: 'rule' }],
  decisions: [],
  actionItems: [],
  origin: 'rule',
};

describe('mergeEntriesToUtterances', () => {
  it('按 relMs 排序并据此映射发言人', () => {
    const u = mergeEntriesToUtterances('m', entries);
    expect(u.map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(u[0].text).toBe('笔记B');
    expect(u[0].speakerId).toBe(NOTE_SPEAKER_ID);
    expect(u[0].source).toBe('manual');
    // 语音条目 → 未知发言人（非笔记发言人）
    expect(u[1].speakerId).not.toBe(NOTE_SPEAKER_ID);
    expect(u[2].text).toBe('语音A');
  });
});

describe('buildSnapshot', () => {
  it('整合出可导出快照：笔记与语音合并进同一条时间轴', () => {
    const snap = buildSnapshot({
      meetingId: 'm',
      title: '速记',
      startedAt: 0,
      endedAt: 120000,
      lang: 'zh-CN',
      hasAudio: false,
      entries,
      struct,
    });
    expect(snap.meeting.title).toBe('速记');
    expect(snap.meeting.durationMs).toBe(120000);
    expect(snap.meeting.status).toBe('ended');
    expect(snap.utterances.length).toBe(3);
    expect(snap.participants.some((p) => p.id === NOTE_SPEAKER_ID && p.name === NOTE_SPEAKER_NAME)).toBe(true);
    expect(snap.topics.length).toBe(1);
    expect(snap.meeting.utteranceCount).toBe(3);
    expect(snap.meeting.searchBlob).toContain('笔记B');
  });

  it('标题为空或纯空白时兜底为「速记会话」', () => {
    const snap = buildSnapshot({
      meetingId: 'm',
      title: '   ',
      startedAt: 0,
      endedAt: 1,
      lang: 'zh-CN',
      hasAudio: false,
      entries: [],
      struct,
    });
    expect(snap.meeting.title).toBe('速记会话');
  });
});
