/**
 * 速记会话状态仓库（Zustand）。
 *
 * 仅负责「会话生命周期 + 原始条目 + interim + 结果」的内存状态，
 * 不持有任何浏览器 / 语音实例——那些由 useQuickSession 编排。
 * 纯状态，可在 Node 环境直接实例化测试。
 */
import { create } from 'zustand';
import type { LangCode, SpeechLevel } from '@/types/models';
import { newId } from '@/lib/utils';
import type { QuickBanner, QuickPhase, QuickSessionResult, SessionEntry } from './types';

export interface QuickState {
  /* ---------- 生命周期 ---------- */
  phase: QuickPhase;
  meetingId: string | null;
  title: string;
  startedAt: number | null;
  endedAt: number | null;
  lang: LangCode;

  /* ---------- 数据 ---------- */
  /** 语音 + 笔记统一条目（按数组顺序追加；展示时再排序） */
  entries: SessionEntry[];
  /** 实时识别的中间文本（不进 entries，独立渲染） */
  interim: string;

  /* ---------- 语音态 ---------- */
  level: SpeechLevel;
  label: string;
  banner: QuickBanner | null;

  /* ---------- 结果 ---------- */
  result: QuickSessionResult | null;
  /** 时钟版本：页面用定时器 tick 触发时长重渲染 */
  clockVersion: number;

  /* ---------- Actions ---------- */
  start: (title?: string, lang?: LangCode) => void;
  addVoice: (text: string, relMs: number, source?: 'asr' | 'manual') => void;
  setInterim: (text: string) => void;
  addNote: (text: string, relMs: number) => void;
  updateNote: (id: string, text: string) => void;
  removeNote: (id: string) => void;
  setLevel: (level: SpeechLevel, label?: string) => void;
  setBanner: (banner: QuickBanner | null) => void;
  tick: () => void;
  loadResult: (result: QuickSessionResult) => void;
  reset: () => void;
}

const EMPTY = {
  phase: 'idle' as QuickPhase,
  meetingId: null as string | null,
  title: '',
  startedAt: null as number | null,
  endedAt: null as number | null,
  lang: 'zh-CN' as LangCode,
  entries: [] as SessionEntry[],
  interim: '',
  level: 0 as SpeechLevel,
  label: '未开始',
  banner: null as QuickBanner | null,
  result: null as QuickSessionResult | null,
  clockVersion: 0,
};

export const useQuickSessionStore = create<QuickState>((set, get) => ({
  ...EMPTY,

  start: (title, lang = 'zh-CN') =>
    set({
      ...EMPTY,
      phase: 'active',
      meetingId: newId(),
      title: title?.trim() || `速记会话 ${new Date().toLocaleString('zh-CN')}`,
      startedAt: Date.now(),
      lang,
      label: '探测识别能力…',
    }),

  addVoice: (text, relMs, source = 'asr') => {
    const t = text.trim();
    if (!t) return;
    set((s) => ({
      entries: [...s.entries, { id: newId(), kind: 'voice', text: t, relMs, createdAt: Date.now(), source }],
    }));
  },

  setInterim: (text) => set({ interim: text }),

  addNote: (text, relMs) => {
    const t = text.trim();
    if (!t) return;
    set((s) => ({
      entries: [...s.entries, { id: newId(), kind: 'note', text: t, relMs, createdAt: Date.now() }],
    }));
  },

  updateNote: (id, text) =>
    set((s) => ({
      entries: s.entries.map((e) => (e.id === id ? { ...e, text: text.trim() || e.text } : e)),
    })),

  removeNote: (id) => set((s) => ({ entries: s.entries.filter((e) => e.id !== id) })),

  setLevel: (level, label) =>
    set((s) => ({
      level,
      label: label ?? (level === 0 ? '实时识别中' : level === 1 ? '录音模式' : '本地模式（手动）'),
    })),

  setBanner: (banner) => set({ banner }),

  tick: () => set((s) => ({ clockVersion: s.clockVersion + 1 })),

  loadResult: (result) =>
    set({ result, phase: 'done', endedAt: result.snapshot.meeting.endedAt, interim: '' }),

  reset: () => set({ ...EMPTY }),
}));

/** 计算当前已用毫秒（连续记录，无暂停） */
export function quickElapsedMs(s: QuickState): number {
  if (s.startedAt == null) return 0;
  const end = s.endedAt ?? Date.now();
  return Math.max(0, end - s.startedAt);
}
