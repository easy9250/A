/**
 * 会话统计：把「原始条目 + 结构化结果」折算成可对外展示的关键指标。
 * 纯函数，便于单元测试，不依赖任何浏览器 API。
 */
import type { SessionEntry, SessionStats } from './types';
import type { StructResult } from '@/core/struct';

/** 统计一次会话的关键信息 */
export function computeSessionStats(input: {
  startedAt: number;
  endedAt: number | null;
  entries: SessionEntry[];
  struct: StructResult;
  hasAudio: boolean;
}): SessionStats {
  const durationMs = input.endedAt ? Math.max(0, input.endedAt - input.startedAt) : 0;

  const notes = input.entries.filter((e) => e.kind === 'note');
  const voices = input.entries.filter((e) => e.kind === 'voice');

  const noteChars = notes.reduce((sum, n) => sum + n.text.trim().length, 0);
  const voiceChars = voices.reduce((sum, v) => sum + v.text.trim().length, 0);
  const openActionCount = input.struct.actionItems.filter((a) => a.status === 'todo').length;

  return {
    durationMs,
    noteCount: notes.length,
    noteChars,
    voiceSegments: voices.length,
    voiceChars,
    entryCount: input.entries.length,
    topicCount: input.struct.topics.length,
    decisionCount: input.struct.decisions.length,
    actionCount: input.struct.actionItems.length,
    openActionCount,
  };
}

/** 取整到秒，便于展示（统计本身仍用毫秒，展示层再格式化） */
export const statSeconds = (ms: number): number => Math.floor(ms / 1000);
