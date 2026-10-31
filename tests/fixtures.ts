import type {
  ActionItem,
  Decision,
  Meeting,
  MeetingSnapshot,
  Participant,
  Topic,
  Utterance,
} from '@/types/models';
import { SCHEMA_VERSION } from '@/types/models';

export const BASE_DATE = new Date(2026, 9, 30, 14, 0, 0, 0).getTime();

export function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'm-1',
    title: '产品周会',
    ownerId: 'local',
    startedAt: BASE_DATE,
    endedAt: BASE_DATE + 3_600_000,
    durationMs: 3_600_000,
    status: 'ended',
    mode: 'web-speech',
    lang: 'zh-CN',
    hasAudio: true,
    searchBlob: '',
    utteranceCount: 3,
    schemaVersion: SCHEMA_VERSION,
    createdAt: BASE_DATE,
    updatedAt: BASE_DATE + 3_600_000,
    ...overrides,
  };
}

export function makeParticipant(
  id: string,
  name: string,
  order: number,
  overrides: Partial<Participant> = {},
): Participant {
  return {
    id,
    meetingId: 'm-1',
    name,
    colorIndex: order % 8,
    order,
    createdAt: BASE_DATE,
    ...overrides,
  };
}

export function makeUtterance(
  id: string,
  seq: number,
  text: string,
  overrides: Partial<Utterance> = {},
): Utterance {
  return {
    id,
    meetingId: 'm-1',
    seq,
    speakerId: null,
    text,
    startMs: (seq - 1) * 10_000,
    endMs: seq * 10_000,
    source: 'asr',
    isFinal: true,
    starred: false,
    createdAt: BASE_DATE + seq,
    ...overrides,
  };
}

export function makeSnapshot(overrides: Partial<MeetingSnapshot> = {}): MeetingSnapshot {
  const participants = [
    makeParticipant('unknown', '未知发言人', -1, { role: 'system', colorIndex: 7 }),
    makeParticipant('p-zhang', '张伟', 0, { role: '主持人' }),
    makeParticipant('p-li', '李娜', 1),
  ];
  const utterances = [
    makeUtterance('u-1', 1, '登录模块重构完成，测试覆盖率达到 82%', { speakerId: 'p-zhang', startMs: 2_000, endMs: 8_000 }),
    makeUtterance('u-2', 2, '我们一致同意采用方案 B', { speakerId: 'p-li', startMs: 10_000, endMs: 18_000 }),
    makeUtterance('u-3', 3, '我来跟进支付接口联调，下周一前完成', { speakerId: 'p-zhang', startMs: 20_000, endMs: 28_000 }),
  ];
  const topics: Topic[] = [
    {
      id: 't-1',
      meetingId: 'm-1',
      order: 0,
      title: '项目进展',
      summary: '登录模块已完成重构',
      bullets: ['测试覆盖率达到 82%'],
      startUtteranceId: 'u-1',
      endUtteranceId: 'u-3',
      origin: 'rule',
      createdAt: BASE_DATE,
    },
  ];
  const decisions: Decision[] = [
    {
      id: 'd-1',
      meetingId: 'm-1',
      content: '采用方案 B',
      sourceUtteranceIds: ['u-2'],
      order: 0,
      confirmed: true,
      origin: 'rule',
      createdAt: BASE_DATE,
    },
  ];
  const actionItems: ActionItem[] = [
    {
      id: 'a-1',
      meetingId: 'm-1',
      content: '跟进支付接口联调',
      assigneeId: 'p-zhang',
      dueDate: '2026-11-02',
      priority: 'P1',
      status: 'todo',
      sourceUtteranceIds: ['u-3'],
      origin: 'rule',
      createdAt: BASE_DATE,
    },
  ];
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: BASE_DATE + 3_600_000,
    meeting: makeMeeting(),
    participants,
    utterances,
    topics,
    decisions,
    actionItems,
    ...overrides,
  };
}
