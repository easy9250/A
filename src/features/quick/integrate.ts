/**
 * 会话整合：把「语音条目 + 笔记条目」按时间轴合并，并映射为通用 MeetingSnapshot，
 * 从而复用既有的结构化整理（RuleStructurer / CloudAiStructurer）、导出与持久化链路。
 */
import type {
  ActionItem,
  Decision,
  LangCode,
  Meeting,
  MeetingSnapshot,
  Participant,
  Topic,
  Utterance,
} from '@/types/models';
import { LOCAL_OWNER_ID, SCHEMA_VERSION, UNKNOWN_SPEAKER_ID } from '@/types/models';
import type { SessionEntry } from './types';
import type { StructResult } from '@/core/struct';

/** 笔记专属发言人的系统保留 id（与 UNKNOWN_SPEAKER_ID 并列） */
export const NOTE_SPEAKER_ID = 'qk-note';
export const NOTE_SPEAKER_NAME = '我的笔记';

/** 笔记发言人（统一放在 participants 中，导出与展示均可区分） */
export function makeNoteParticipant(meetingId: string): Participant {
  return {
    id: NOTE_SPEAKER_ID,
    meetingId,
    name: NOTE_SPEAKER_NAME,
    role: 'note',
    colorIndex: 6,
    order: 0,
    createdAt: Date.now(),
  };
}

/** 系统保留的「未知发言人」（语音转写默认归属） */
export function makeUnknownParticipant(meetingId: string): Participant {
  return {
    id: UNKNOWN_SPEAKER_ID,
    meetingId,
    name: '未知发言人',
    role: 'system',
    colorIndex: 7,
    order: -1,
    createdAt: Date.now(),
  };
}

/** 由会话片段构造 Meeting 实体（供 structureMeeting 入参与导出复用） */
export function sessionMeeting(input: {
  meetingId: string;
  title: string;
  startedAt: number;
  endedAt: number;
  lang: LangCode;
  hasAudio: boolean;
  audioLocalKey?: string;
  utteranceCount?: number;
  searchBlob?: string;
}): Meeting {
  const now = Date.now();
  return {
    id: input.meetingId,
    title: input.title.trim() || '速记会话',
    ownerId: LOCAL_OWNER_ID,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: Math.max(0, input.endedAt - input.startedAt),
    status: 'ended',
    mode: 'manual',
    lang: input.lang,
    hasAudio: input.hasAudio,
    audioLocalKey: input.audioLocalKey,
    searchBlob: input.searchBlob ?? '',
    utteranceCount: input.utteranceCount ?? 0,
    schemaVersion: SCHEMA_VERSION,
    createdAt: input.startedAt,
    updatedAt: now,
  };
}

/**
 * 把会话条目（语音 + 笔记）按时间轴合并为统一发言序列。
 * - 语音条目 → speakerId = 未知发言人，source = asr / manual；
 * - 笔记条目 → speakerId = 我的笔记，source = manual。
 */
export function mergeEntriesToUtterances(meetingId: string, entries: SessionEntry[]): Utterance[] {
  const sorted = [...entries].sort((a, b) => a.relMs - b.relMs || a.createdAt - b.createdAt);
  return sorted.map((e, i): Utterance => ({
    id: e.id,
    meetingId,
    seq: i + 1,
    speakerId: e.kind === 'note' ? NOTE_SPEAKER_ID : UNKNOWN_SPEAKER_ID,
    text: e.text.trim(),
    startMs: e.relMs,
    endMs: e.relMs,
    source: e.kind === 'note' ? 'manual' : e.source ?? 'asr',
    confidence: undefined,
    isFinal: true,
    marker: null,
    starred: false,
    createdAt: e.createdAt,
  }));
}

/**
 * 由会话整合出可导出 / 持久化的 MeetingSnapshot。
 * 笔记与语音被合并进同一条 utterances 时间轴，再交给结构化器产出议题 / 决议 / 待办，
 * 实现「笔记内容与录音内容梳理整合」。
 */
export function buildSnapshot(input: {
  meetingId: string;
  title: string;
  startedAt: number;
  endedAt: number;
  lang: LangCode;
  hasAudio: boolean;
  audioLocalKey?: string;
  entries: SessionEntry[];
  struct: StructResult;
}): MeetingSnapshot {
  const now = Date.now();
  const utterances = mergeEntriesToUtterances(input.meetingId, input.entries);
  const participants: Participant[] = [makeNoteParticipant(input.meetingId), makeUnknownParticipant(input.meetingId)];

  const meeting = sessionMeeting({
    meetingId: input.meetingId,
    title: input.title,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    lang: input.lang,
    hasAudio: input.hasAudio,
    audioLocalKey: input.audioLocalKey,
    utteranceCount: utterances.length,
    searchBlob: utterances.map((u) => u.text).join(' ').slice(0, 20000),
  });

  const topics: Topic[] = input.struct.topics.map((t, i) => ({ ...t, meetingId: input.meetingId, order: i, createdAt: now }));
  const decisions: Decision[] = input.struct.decisions.map((d, i) => ({
    ...d,
    meetingId: input.meetingId,
    order: i,
    createdAt: now,
  }));
  const actionItems: ActionItem[] = input.struct.actionItems.map((a) => ({ ...a, meetingId: input.meetingId, createdAt: now }));

  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now,
    meeting,
    participants,
    utterances,
    topics,
    decisions,
    actionItems,
  };
}
