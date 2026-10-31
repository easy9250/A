import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_UNDO_DEPTH, useMeetingStore } from '@/stores/useMeetingStore';

function st() {
  return useMeetingStore.getState();
}

function addThreeUtterances(speakers: Array<string | null>) {
  return speakers.map((speakerId, index) =>
    st().addUtterance({
      text: `第 ${index + 1} 条发言`,
      speakerId,
      startMs: index * 10_000,
      endMs: index * 10_000 + 8_000,
      source: 'manual',
    }),
  );
}

describe('useMeetingStore 发言人归属与删除参会人', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 30, 14, 0));
    st().reset();
    st().startMeeting('QA 会议');
  });

  afterEach(() => {
    st().reset();
    vi.useRealTimers();
  });

  it('支持单条、从此处起、按原发言人三种重归属，并逐步撤销', () => {
    const zhang = st().addParticipant('张伟')!;
    const li = st().addParticipant('李娜')!;
    const [u1, u2, u3] = addThreeUtterances([zhang.id, zhang.id, li.id]);
    const baseDepth = st().undoDepth;

    st().reassignUtterance(u1!.id, li.id);
    expect(st().uttMap[u1!.id].speakerId).toBe(li.id);
    expect(st().undoDepth).toBe(baseDepth + 1);

    expect(st().previewReassignFromHere(u2!.id)).toBe(2);
    expect(st().reassignFromHere(u2!.id, li.id)).toBe(1);
    expect(st().uttMap[u2!.id].speakerId).toBe(li.id);
    expect(st().uttMap[u3!.id].speakerId).toBe(li.id);

    expect(st().previewReassignBySpeaker(li.id)).toBe(3);
    expect(st().reassignBySpeaker(li.id, null)).toBe(3);
    expect([u1, u2, u3].map((u) => st().uttMap[u!.id].speakerId)).toEqual([null, null, null]);

    const beforeUndo = st().undoDepth;
    expect(st().undo()).toBe(true);
    expect(st().undoDepth).toBe(beforeUndo - 1);
    expect([u1, u2, u3].map((u) => st().uttMap[u!.id].speakerId)).toEqual([li.id, li.id, li.id]);

    expect(st().undo()).toBe(true);
    expect([u1, u2, u3].map((u) => st().uttMap[u!.id].speakerId)).toEqual([li.id, zhang.id, li.id]);

    expect(st().undo()).toBe(true);
    expect([u1, u2, u3].map((u) => st().uttMap[u!.id].speakerId)).toEqual([zhang.id, zhang.id, li.id]);
  });

  it('删除参会人仅把相关发言和待办负责人置空，不丢失发言', () => {
    const zhang = st().addParticipant('张伟')!;
    const li = st().addParticipant('李娜')!;
    const [u1, u2] = addThreeUtterances([zhang.id, li.id]).slice(0, 2);
    st().addActionItem({
      content: '输出报告',
      assigneeId: zhang.id,
      dueDate: null,
      priority: 'P2',
      status: 'todo',
      sourceUtteranceIds: [u1!.id],
      origin: 'manual',
    });
    const idsBefore = [...st().utteranceIds];

    st().removeParticipant(zhang.id);

    expect(st().utteranceIds).toEqual(idsBefore);
    expect(st().uttMap[u1!.id].speakerId).toBeNull();
    expect(st().uttMap[u2!.id].speakerId).toBe(li.id);
    expect(st().actionItems[0].assigneeId).toBeNull();
    expect(st().participants.some((p) => p.id === zhang.id)).toBe(false);
  });
});

describe('useMeetingStore 合并、拆分、撤销栈与累计时钟', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 30, 14, 0));
    st().reset();
    st().startMeeting('QA 会议');
  });

  afterEach(() => {
    st().reset();
    vi.useRealTimers();
  });

  it('合并相邻发言后保留最早开始和最晚结束，拆分后时间连续且 seq 单调', () => {
    const speaker = st().addParticipant('张伟')!;
    const first = st().addUtterance({
      text: '第一部分',
      speakerId: speaker.id,
      startMs: 1_000,
      endMs: 4_000,
      source: 'manual',
    })!;
    const second = st().addUtterance({
      text: '第二部分',
      speakerId: speaker.id,
      startMs: 5_000,
      endMs: 9_000,
      source: 'manual',
    })!;

    const mergedId = st().mergeUtterances([first.id, second.id]);

    expect(mergedId).toBe(first.id);
    expect(st().utteranceIds).toEqual([first.id]);
    expect(st().uttMap[first.id]).toMatchObject({
      text: '第一部分 第二部分',
      startMs: 1_000,
      endMs: 9_000,
      seq: 1,
      source: 'edited',
    });

    const splitId = st().splitUtterance(first.id, 4)!;
    const [left, right] = st().utteranceIds.map((id) => st().uttMap[id]);
    expect(splitId).toBe(right.id);
    expect(left.endMs).toBe(right.startMs);
    expect([left.seq, right.seq]).toEqual([1, 2]);
    expect(left.startMs).toBe(1_000);
    expect(right.endMs).toBe(9_000);
    expect(left.text).toBe('第一部分');
    expect(right.text).toBe('第二部分');
  });

  it('撤销栈达到上限后保持 MAX_UNDO_DEPTH，且每次 undo 深度递减', () => {
    const utterance = st().addUtterance({ text: '初始文本', source: 'manual' })!;

    for (let index = 0; index < MAX_UNDO_DEPTH + 7; index += 1) {
      st().updateUtterance(utterance.id, { text: `版本 ${index}` });
    }

    expect(st().undoDepth).toBe(MAX_UNDO_DEPTH);
    for (let remaining = MAX_UNDO_DEPTH - 1; remaining >= 0; remaining -= 1) {
      expect(st().undo()).toBe(true);
      expect(st().undoDepth).toBe(remaining);
    }
    expect(st().canUndo()).toBe(false);
    expect(st().undo()).toBe(false);
  });

  it('pause/resume 后 elapsedMs 不累计暂停时间', () => {
    expect(st().elapsedMs()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(st().elapsedMs()).toBe(5_000);

    st().pauseMeeting();
    expect(st().elapsedMs()).toBe(5_000);
    vi.advanceTimersByTime(12_000);
    expect(st().elapsedMs()).toBe(5_000);

    st().resumeMeeting();
    vi.advanceTimersByTime(3_000);
    expect(st().elapsedMs()).toBe(8_000);
    st().endMeeting();
    vi.advanceTimersByTime(9_000);
    expect(st().elapsedMs()).toBe(8_000);
  });
});
