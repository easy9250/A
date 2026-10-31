import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type {
  ActionItem,
  ActionPriority,
  ActionStatus,
  Decision,
  LangCode,
  MarkerKind,
  Meeting,
  MeetingSnapshot,
  Participant,
  SpeechMode,
  SpeechLevel,
  Topic,
  Utterance,
  UtteranceSource,
} from '@/types/models';
import { MAX_PARTICIPANTS, SCHEMA_VERSION, UNKNOWN_SPEAKER_ID, LOCAL_OWNER_ID } from '@/types/models';
import { newId } from '@/lib/utils';

/** 新增发言入参 */
export interface AddUtteranceInput {
  text: string;
  speakerId?: string | null;
  /** 相对会议开始的「活动」毫秒；缺省取当前 elapsedMs() */
  startMs?: number;
  endMs?: number;
  source?: UtteranceSource;
  confidence?: number;
  isFinal?: boolean;
}

/** 结构化结果（与 core/struct 的 StructResult 对齐，避免 store 反向依赖 core） */
export interface ApplyStructPayload {
  topics: Omit<Topic, 'createdAt'>[];
  decisions: Omit<Decision, 'createdAt'>[];
  actionItems: Omit<ActionItem, 'createdAt'>[];
}

/** 会议时钟：activeMs 累计 + resumeAt 起点 */
export interface ClockState {
  /** 已累计的活动毫秒 */
  activeMs: number;
  /** 处于 active 时的本次计时起点；非 active 为 null */
  resumeAt: number | null;
}

/** 撤销命令（命令式：保存逆操作闭包） */
interface UndoEntry {
  label: string;
  undo: () => void;
}

/** 撤销栈深度上限（要求 ≥20，取 30 留余量） */
export const MAX_UNDO_DEPTH = 30;

export interface MeetingState {
  /* ---------- 数据 ---------- */
  meeting: Meeting | null;
  participants: Participant[];
  /** 只存 id 顺序：容器订阅它，行订阅 uttMap[id]，互不干扰 */
  utteranceIds: string[];
  uttMap: Record<string, Utterance>;
  topics: Topic[];
  decisions: Decision[];
  actionItems: ActionItem[];
  /** 被打点的 utterance id（P1-07，便于快速筛选） */
  markerIds: string[];

  /* ---------- 会话态 ---------- */
  currentSpeakerId: string | null;
  /** 下一个可用的 seq（单调递增，从 1 开始） */
  seqCounter: number;
  clock: ClockState;
  /** 时钟版本号：UI 用定时器调用 tick() 触发重渲染 */
  clockVersion: number;

  /* ---------- 持久化态 ---------- */
  dirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;
  undoDepth: number;
  undoLabel: string | null;

  /* ---------- 会议生命周期 ---------- */
  startMeeting: (title: string, opts?: { lang?: LangCode; mode?: SpeechMode; speechLevel?: SpeechLevel }) => Meeting;
  pauseMeeting: () => void;
  resumeMeeting: () => void;
  endMeeting: (opts?: { hasAudio?: boolean; durationMs?: number }) => void;
  elapsedMs: () => number;
  tick: () => void;
  patchMeeting: (patch: Partial<Pick<Meeting, 'title' | 'lang' | 'mode' | 'audioLocalKey' | 'audioUrl' | 'hasAudio'>>) => void;
  loadSnapshot: (s: MeetingSnapshot) => void;
  getSnapshot: () => MeetingSnapshot | null;
  reset: () => void;
  markSaved: () => void;
  setSaving: (v: boolean) => void;

  /* ---------- 参会人 ---------- */
  addParticipant: (name: string, role?: string) => Participant | null;
  updateParticipant: (id: string, patch: Partial<Pick<Participant, 'name' | 'role' | 'colorIndex'>>) => void;
  removeParticipant: (id: string) => void;
  reorderParticipants: (orderedIds: string[]) => void;
  setCurrentSpeaker: (id: string | null) => void;

  /* ---------- 发言 ---------- */
  addUtterance: (input: AddUtteranceInput) => Utterance | null;
  updateUtterance: (
    id: string,
    patch: Partial<Pick<Utterance, 'text' | 'speakerId' | 'marker' | 'starred' | 'isFinal' | 'startMs' | 'endMs' | 'source'>>,
  ) => void;
  reassignUtterance: (id: string, speakerId: string | null) => void;
  /** 「从此处起批量改为 X」的影响条数预览 */
  previewReassignFromHere: (id: string) => number;
  reassignFromHere: (id: string, speakerId: string | null) => number;
  /** 「按发言人批量重归属」的影响条数预览 */
  previewReassignBySpeaker: (fromSpeakerId: string | null) => number;
  reassignBySpeaker: (fromSpeakerId: string | null, toSpeakerId: string | null) => number;
  deleteUtterance: (id: string) => void;
  deleteUtterances: (ids: string[]) => void;
  mergeUtterances: (ids: string[]) => string | null;
  splitUtterance: (id: string, at: number) => string | null;
  setMarker: (id: string, kind: MarkerKind | null) => void;
  toggleStar: (id: string) => void;

  /* ---------- 结构化产出 ---------- */
  applyStructResult: (r: ApplyStructPayload) => void;
  setTopics: (next: Topic[]) => void;
  addTopic: (t: Omit<Topic, 'id' | 'createdAt' | 'meetingId' | 'order'> & { id?: string }) => Topic | null;
  updateTopic: (id: string, patch: Partial<Pick<Topic, 'title' | 'summary' | 'bullets' | 'startUtteranceId' | 'endUtteranceId' | 'origin'>>) => void;
  removeTopic: (id: string) => void;
  moveTopic: (id: string, dir: -1 | 1) => void;
  setDecisions: (next: Decision[]) => void;
  addDecision: (d: Omit<Decision, 'id' | 'createdAt' | 'meetingId' | 'order'> & { id?: string }) => Decision | null;
  updateDecision: (id: string, patch: Partial<Pick<Decision, 'content' | 'confirmed' | 'order' | 'sourceUtteranceIds' | 'origin'>>) => void;
  removeDecision: (id: string) => void;
  setActionItems: (next: ActionItem[]) => void;
  addActionItem: (a: Omit<ActionItem, 'id' | 'createdAt' | 'meetingId'> & { id?: string }) => ActionItem | null;
  updateActionItem: (
    id: string,
    patch: Partial<Pick<ActionItem, 'content' | 'assigneeId' | 'dueDate' | 'priority' | 'status' | 'sourceUtteranceIds' | 'origin'>>,
  ) => void;
  removeActionItem: (id: string) => void;

  /* ---------- 撤销 ---------- */
  undo: () => boolean;
  canUndo: () => boolean;
}

/** 撤销栈（模块级，不放进 state，避免深拷贝带来的订阅抖动） */
let undoStack: UndoEntry[] = [];

/** 取当前 store 的 set 引用（模块初始化后由 store 内部赋值） */
let setUndoDepth: ((depth: number, label: string | null) => void) | null = null;

/** 压入撤销命令 */
function pushUndo(label: string, undo: () => void): void {
  undoStack.push({ label, undo });
  if (undoStack.length > MAX_UNDO_DEPTH) undoStack.shift();
  setUndoDepth?.(undoStack.length, label);
}

/** 构造系统保留的「未知发言人」 */
function makeUnknownParticipant(meetingId: string): Participant {
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

/** 重排 seq 为 1..n，并回填 seqCounter（保证无空洞、无重复） */
function renumber(ids: string[], map: Record<string, Utterance>): { uttMap: Record<string, Utterance>; seqCounter: number } {
  const next: Record<string, Utterance> = { ...map };
  let changed = false;
  ids.forEach((id, i) => {
    const u = next[id];
    if (u && u.seq !== i + 1) {
      next[id] = { ...u, seq: i + 1 };
      changed = true;
    }
  });
  return { uttMap: changed ? next : map, seqCounter: ids.length + 1 };
}

const EMPTY = {
  meeting: null,
  participants: [] as Participant[],
  utteranceIds: [] as string[],
  uttMap: {} as Record<string, Utterance>,
  topics: [] as Topic[],
  decisions: [] as Decision[],
  actionItems: [] as ActionItem[],
  markerIds: [] as string[],
  currentSpeakerId: null as string | null,
  seqCounter: 1,
  clock: { activeMs: 0, resumeAt: null } as ClockState,
  clockVersion: 0,
  dirty: false,
  saving: false,
  lastSavedAt: null as number | null,
  undoDepth: 0,
  undoLabel: null as string | null,
};

export const useMeetingStore = create<MeetingState>()(
  subscribeWithSelector((set, get) => {
    setUndoDepth = (depth, label) => set({ undoDepth: depth, undoLabel: label });

    return {
      ...EMPTY,

      /* ==================== 生命周期 ==================== */

      startMeeting: (title, opts) => {
        const now = Date.now();
        const id = newId();
        const meeting: Meeting = {
          id,
          title: title.trim() || `会议 ${new Date(now).toLocaleString('zh-CN')}`,
          ownerId: LOCAL_OWNER_ID,
          startedAt: now,
          endedAt: null,
          durationMs: 0,
          status: 'active',
          mode: opts?.mode ?? 'web-speech',
          lang: opts?.lang ?? 'zh-CN',
          hasAudio: false,
          searchBlob: '',
          utteranceCount: 0,
          schemaVersion: SCHEMA_VERSION,
          createdAt: now,
          updatedAt: now,
        };
        undoStack = [];
        set({
          ...EMPTY,
          meeting,
          participants: [makeUnknownParticipant(id)],
          clock: { activeMs: 0, resumeAt: now },
          dirty: true,
          undoDepth: 0,
          undoLabel: null,
        });
        return meeting;
      },

      pauseMeeting: () => {
        const st = get();
        if (!st.meeting || st.meeting.status !== 'active') return;
        const now = Date.now();
        const activeMs = st.clock.activeMs + (st.clock.resumeAt ? now - st.clock.resumeAt : 0);
        set({
          meeting: { ...st.meeting, status: 'paused', durationMs: activeMs, updatedAt: now },
          clock: { activeMs, resumeAt: null },
          dirty: true,
        });
      },

      resumeMeeting: () => {
        const st = get();
        if (!st.meeting || st.meeting.status !== 'paused') return;
        const now = Date.now();
        set({
          meeting: { ...st.meeting, status: 'active', updatedAt: now },
          clock: { activeMs: st.clock.activeMs, resumeAt: now },
        });
      },

      endMeeting: (opts) => {
        const st = get();
        if (!st.meeting || st.meeting.status === 'ended') return;
        const now = Date.now();
        const activeMs = st.clock.activeMs + (st.clock.resumeAt ? now - st.clock.resumeAt : 0);
        const durationMs = opts?.durationMs ?? activeMs;
        set({
          meeting: {
            ...st.meeting,
            status: 'ended',
            endedAt: now,
            durationMs,
            hasAudio: opts?.hasAudio ?? st.meeting.hasAudio,
            utteranceCount: st.utteranceIds.length,
            updatedAt: now,
          },
          clock: { activeMs: durationMs, resumeAt: null },
          dirty: true,
        });
      },

      /** 累计活动时长（不含暂停） */
      elapsedMs: () => {
        const st = get();
        if (!st.meeting) return 0;
        const base = st.clock.activeMs;
        if (st.meeting.status === 'active' && st.clock.resumeAt) return base + (Date.now() - st.clock.resumeAt);
        return base;
      },

      tick: () => set((s) => ({ clockVersion: s.clockVersion + 1 })),

      patchMeeting: (patch) => {
        const st = get();
        if (!st.meeting) return;
        set({ meeting: { ...st.meeting, ...patch, updatedAt: Date.now() }, dirty: true });
      },

      loadSnapshot: (s) => {
        const ids = s.utterances.map((u) => u.id);
        const uttMap: Record<string, Utterance> = {};
        for (const u of s.utterances) uttMap[u.id] = u;
        let maxSeq = 0;
        for (const u of s.utterances) if (u.seq > maxSeq) maxSeq = u.seq;
        undoStack = [];
        const activeMs = s.meeting.durationMs || 0;
        set({
          ...EMPTY,
          meeting: s.meeting,
          participants: s.participants.length > 0 ? s.participants : [makeUnknownParticipant(s.meeting.id)],
          utteranceIds: ids,
          uttMap,
          topics: s.topics,
          decisions: s.decisions,
          actionItems: s.actionItems,
          markerIds: s.utterances.filter((u) => u.marker).map((u) => u.id),
          seqCounter: maxSeq + 1,
          clock: {
            activeMs,
            resumeAt: s.meeting.status === 'active' ? Date.now() : null,
          },
          dirty: false,
          lastSavedAt: s.meeting.updatedAt ?? null,
          undoDepth: 0,
          undoLabel: null,
        });
      },

      getSnapshot: () => {
        const st = get();
        if (!st.meeting) return null;
        const utterances = st.utteranceIds.map((id) => st.uttMap[id]).filter(Boolean);
        return {
          schemaVersion: SCHEMA_VERSION,
          exportedAt: Date.now(),
          meeting: { ...st.meeting, utteranceCount: utterances.length },
          participants: st.participants,
          utterances,
          topics: st.topics,
          decisions: st.decisions,
          actionItems: st.actionItems,
        };
      },

      reset: () => {
        undoStack = [];
        set({ ...EMPTY });
      },

      markSaved: () => set({ dirty: false, lastSavedAt: Date.now(), saving: false }),
      setSaving: (v) => set({ saving: v }),

      /* ==================== 参会人 ==================== */

      addParticipant: (name, role) => {
        const st = get();
        if (!st.meeting) return null;
        const clean = name.trim();
        if (!clean) return null;
        const real = st.participants.filter((p) => p.id !== UNKNOWN_SPEAKER_ID);
        if (real.length >= MAX_PARTICIPANTS) return null;
        const maxOrder = real.reduce((m, p) => Math.max(m, p.order), -1);
        const p: Participant = {
          id: newId(),
          meetingId: st.meeting.id,
          name: clean,
          role: role?.trim() || undefined,
          colorIndex: (maxOrder + 1) % 8,
          order: maxOrder + 1,
          createdAt: Date.now(),
        };
        const prev = st.participants;
        set({ participants: [...prev, p], dirty: true });
        pushUndo(`添加参会人「${clean}」`, () => set({ participants: prev, dirty: true }));
        return p;
      },

      updateParticipant: (id, patch) => {
        const st = get();
        if (!st.meeting) return;
        const prev = st.participants;
        const next = prev.map((p) => (p.id === id ? { ...p, ...patch } : p));
        set({ participants: next, dirty: true });
        pushUndo('修改参会人', () => set({ participants: prev, dirty: true }));
      },

      removeParticipant: (id) => {
        const st = get();
        if (!st.meeting || id === UNKNOWN_SPEAKER_ID) return;
        const prevParticipants = st.participants;
        const prevUttMap = st.uttMap;
        const prevActionItems = st.actionItems;
        const prevCurrent = st.currentSpeakerId;

        const participants = prevParticipants.filter((p) => p.id !== id);
        // 发言绝不丢失：speakerId 置 null → 渲染为「未知发言人」
        const uttMap: Record<string, Utterance> = {};
        for (const uid of Object.keys(prevUttMap)) {
          const u = prevUttMap[uid];
          uttMap[uid] = u.speakerId === id ? { ...u, speakerId: null } : u;
        }
        const actionItems = prevActionItems.map((a) => (a.assigneeId === id ? { ...a, assigneeId: null } : a));
        set({
          participants,
          uttMap,
          actionItems,
          currentSpeakerId: prevCurrent === id ? null : prevCurrent,
          dirty: true,
        });
        pushUndo('删除参会人', () =>
          set({
            participants: prevParticipants,
            uttMap: prevUttMap,
            actionItems: prevActionItems,
            currentSpeakerId: prevCurrent,
            dirty: true,
          }),
        );
      },

      reorderParticipants: (orderedIds) => {
        const st = get();
        const prev = st.participants;
        const pos = new Map(orderedIds.map((id, i) => [id, i]));
        const next = [...prev].sort((a, b) => (pos.get(a.id) ?? 999) - (pos.get(b.id) ?? 999));
        set({ participants: next, dirty: true });
        pushUndo('调整参会人顺序', () => set({ participants: prev, dirty: true }));
      },

      setCurrentSpeaker: (id) => set({ currentSpeakerId: id }),

      /* ==================== 发言 ==================== */

      addUtterance: (input) => {
        const st = get();
        if (!st.meeting) return null;
        const text = input.text.trim();
        if (!text) return null;
        const id = newId();
        const seq = st.seqCounter;
        const startMs = input.startMs ?? st.elapsedMs();
        const endMs = input.endMs ?? startMs;
        const utt: Utterance = {
          id,
          meetingId: st.meeting.id,
          seq,
          speakerId: input.speakerId !== undefined ? input.speakerId : st.currentSpeakerId,
          text,
          startMs,
          endMs,
          source: input.source ?? 'asr',
          confidence: input.confidence,
          isFinal: input.isFinal ?? true,
          marker: null,
          starred: false,
          createdAt: Date.now(),
        };
        set({
          uttMap: { ...st.uttMap, [id]: utt },
          utteranceIds: [...st.utteranceIds, id],
          seqCounter: seq + 1,
          dirty: true,
        });
        pushUndo('新增发言', () =>
          set((s) => {
            const map = { ...s.uttMap };
            delete map[id];
            const ids = s.utteranceIds.filter((x) => x !== id);
            const r = renumber(ids, map);
            return { uttMap: r.uttMap, utteranceIds: ids, seqCounter: r.seqCounter, dirty: true };
          }),
        );
        return utt;
      },

      updateUtterance: (id, patch) => {
        const st = get();
        const prev = st.uttMap[id];
        if (!prev) return;
        const next: Utterance = { ...prev, ...patch };
        if ('text' in patch) next.source = prev.source === 'asr' ? 'edited' : prev.source;
        set({ uttMap: { ...st.uttMap, [id]: next }, dirty: true });
        pushUndo('编辑发言', () => set((s) => ({ uttMap: { ...s.uttMap, [id]: prev }, dirty: true })));
      },

      reassignUtterance: (id, speakerId) => {
        const st = get();
        const prev = st.uttMap[id];
        if (!prev || prev.speakerId === speakerId) return;
        set({ uttMap: { ...st.uttMap, [id]: { ...prev, speakerId } }, dirty: true });
        pushUndo('修改发言人归属', () => set((s) => ({ uttMap: { ...s.uttMap, [id]: prev }, dirty: true })));
      },

      previewReassignFromHere: (id) => {
        const st = get();
        const idx = st.utteranceIds.indexOf(id);
        if (idx < 0) return 0;
        return st.utteranceIds.length - idx;
      },

      reassignFromHere: (id, speakerId) => {
        const st = get();
        const idx = st.utteranceIds.indexOf(id);
        if (idx < 0) return 0;
        const targets = st.utteranceIds.slice(idx);
        const changed: Array<{ id: string; prev: string | null }> = [];
        const uttMap = { ...st.uttMap };
        for (const uid of targets) {
          const u = uttMap[uid];
          if (!u || u.speakerId === speakerId) continue;
          changed.push({ id: uid, prev: u.speakerId });
          uttMap[uid] = { ...u, speakerId };
        }
        if (changed.length === 0) return 0;
        set({ uttMap, dirty: true });
        pushUndo(`从此处起批量改为 ${changed.length} 条`, () =>
          set((s) => {
            const m = { ...s.uttMap };
            for (const c of changed) {
              const u = m[c.id];
              if (u) m[c.id] = { ...u, speakerId: c.prev };
            }
            return { uttMap: m, dirty: true };
          }),
        );
        return changed.length;
      },

      previewReassignBySpeaker: (fromSpeakerId) => {
        const st = get();
        let n = 0;
        for (const id of st.utteranceIds) {
          const u = st.uttMap[id];
          if (u && u.speakerId === fromSpeakerId) n += 1;
        }
        return n;
      },

      reassignBySpeaker: (fromSpeakerId, toSpeakerId) => {
        const st = get();
        if (fromSpeakerId === toSpeakerId) return 0;
        const changed: Array<{ id: string; prev: string | null }> = [];
        const uttMap = { ...st.uttMap };
        for (const id of st.utteranceIds) {
          const u = uttMap[id];
          if (!u || u.speakerId !== fromSpeakerId) continue;
          changed.push({ id, prev: u.speakerId });
          uttMap[id] = { ...u, speakerId: toSpeakerId };
        }
        if (changed.length === 0) return 0;
        set({ uttMap, dirty: true });
        pushUndo(`按发言人批量重归属 ${changed.length} 条`, () =>
          set((s) => {
            const m = { ...s.uttMap };
            for (const c of changed) {
              const u = m[c.id];
              if (u) m[c.id] = { ...u, speakerId: c.prev };
            }
            return { uttMap: m, dirty: true };
          }),
        );
        return changed.length;
      },

      deleteUtterance: (id) => get().deleteUtterances([id]),

      deleteUtterances: (ids) => {
        const st = get();
        const idSet = new Set(ids);
        const prevIds = st.utteranceIds;
        const prevMap = st.uttMap;
        const removed = prevIds
          .map((id, index) => ({ id, index, u: prevMap[id] }))
          .filter((x) => idSet.has(x.id) && x.u);
        if (removed.length === 0) return;
        const nextIds = prevIds.filter((id) => !idSet.has(id));
        const map: Record<string, Utterance> = {};
        for (const id of nextIds) map[id] = prevMap[id];
        const r = renumber(nextIds, map);
        set({ utteranceIds: nextIds, uttMap: r.uttMap, seqCounter: r.seqCounter, dirty: true });
        pushUndo(`删除 ${removed.length} 条发言`, () =>
          set((s) => {
            const m = { ...s.uttMap };
            const list = [...s.utteranceIds];
            for (const item of removed) {
              m[item.id] = item.u;
              list.splice(Math.min(item.index, list.length), 0, item.id);
            }
            const rr = renumber(list, m);
            return { utteranceIds: list, uttMap: rr.uttMap, seqCounter: rr.seqCounter, dirty: true };
          }),
        );
      },

      mergeUtterances: (ids) => {
        const st = get();
        if (ids.length < 2) return null;
        const ordered = st.utteranceIds.filter((id) => ids.includes(id));
        if (ordered.length < 2) return null;
        const headId = ordered[0];
        const head = st.uttMap[headId];
        if (!head) return null;
        const parts: string[] = [];
        let endMs = head.endMs;
        const removed: Array<{ id: string; index: number; u: Utterance }> = [];
        for (const id of ordered) {
          const u = st.uttMap[id];
          if (!u) continue;
          parts.push(u.text);
          if (u.endMs > endMs) endMs = u.endMs;
          if (id !== headId) removed.push({ id, index: st.utteranceIds.indexOf(id), u });
        }
        if (removed.length === 0) return null;

        const prevHead = head;
        const prevIds = st.utteranceIds;
        const prevMap = st.uttMap;
        const merged: Utterance = {
          ...head,
          text: parts.join(' '),
          endMs,
          source: 'edited',
          isFinal: true,
        };
        const nextIds = prevIds.filter((id) => !removed.some((r) => r.id === id));
        const map: Record<string, Utterance> = { ...prevMap, [headId]: merged };
        for (const r of removed) delete map[r.id];
        const r2 = renumber(nextIds, map);
        set({ utteranceIds: nextIds, uttMap: r2.uttMap, seqCounter: r2.seqCounter, dirty: true });
        pushUndo(`合并 ${ordered.length} 条发言`, () =>
          set((s) => {
            const m = { ...s.uttMap, [headId]: prevHead };
            const list = [...s.utteranceIds];
            for (const item of removed) {
              m[item.id] = item.u;
              list.splice(Math.min(item.index, list.length), 0, item.id);
            }
            const rr = renumber(list, m);
            return { utteranceIds: list, uttMap: rr.uttMap, seqCounter: rr.seqCounter, dirty: true };
          }),
        );
        return headId;
      },

      splitUtterance: (id, at) => {
        const st = get();
        const src = st.uttMap[id];
        if (!src) return null;
        const text = src.text ?? '';
        const pos = Math.max(1, Math.min(text.length - 1, Math.floor(at)));
        if (text.length < 2 || pos < 1 || pos >= text.length) return null;
        const left = text.slice(0, pos).trim();
        const right = text.slice(pos).trim();
        if (!left || !right) return null;

        const prevIds = st.utteranceIds;
        const prevMap = st.uttMap;
        const newUttId = newId();
        const now = Date.now();
        const midMs = Math.floor((src.startMs + src.endMs) / 2);
        const leftU: Utterance = { ...src, text: left, endMs: midMs, source: 'edited', isFinal: true };
        const rightU: Utterance = {
          ...src,
          id: newUttId,
          seq: src.seq + 1,
          text: right,
          startMs: midMs,
          endMs: src.endMs,
          source: 'edited',
          isFinal: true,
          createdAt: now,
        };
        const idx = prevIds.indexOf(id);
        const nextIds = [...prevIds.slice(0, idx + 1), newUttId, ...prevIds.slice(idx + 1)];
        const map: Record<string, Utterance> = { ...prevMap, [id]: leftU, [newUttId]: rightU };
        const r = renumber(nextIds, map);
        set({ utteranceIds: nextIds, uttMap: r.uttMap, seqCounter: r.seqCounter, dirty: true });
        pushUndo('拆分发言', () =>
          set(() => ({ utteranceIds: prevIds, uttMap: prevMap, seqCounter: prevIds.length + 1, dirty: true })),
        );
        return newUttId;
      },

      setMarker: (id, kind) => {
        const st = get();
        const prev = st.uttMap[id];
        if (!prev) return;
        const prevMarker = prev.marker ?? null;
        const next: Utterance = { ...prev, marker: kind, starred: kind === 'important' };
        const markerIds = kind
          ? Array.from(new Set([...st.markerIds, id]))
          : st.markerIds.filter((x) => x !== id);
        set({ uttMap: { ...st.uttMap, [id]: next }, markerIds, dirty: true });
        pushUndo('切换打点', () =>
          set((s) => ({
            uttMap: { ...s.uttMap, [id]: prev },
            markerIds: prevMarker
              ? Array.from(new Set([...s.markerIds, id]))
              : s.markerIds.filter((x) => x !== id),
            dirty: true,
          })),
        );
      },

      toggleStar: (id) => {
        const st = get();
        const u = st.uttMap[id];
        if (!u) return;
        st.setMarker(id, u.starred ? null : 'important');
      },

      /* ==================== 结构化产出 ==================== */

      applyStructResult: (r) => {
        const st = get();
        if (!st.meeting) return;
        const now = Date.now();
        const prevTopics = st.topics;
        const prevDecisions = st.decisions;
        const prevActions = st.actionItems;
        const topics: Topic[] = r.topics.map((t, i) => ({ ...t, order: t.order ?? i, createdAt: now }));
        const decisions: Decision[] = r.decisions.map((d, i) => ({ ...d, order: d.order ?? i, createdAt: now }));
        const actionItems: ActionItem[] = r.actionItems.map((a) => ({ ...a, createdAt: now }));
        set({ topics, decisions, actionItems, dirty: true });
        pushUndo('应用结构化整理结果', () =>
          set({ topics: prevTopics, decisions: prevDecisions, actionItems: prevActions, dirty: true }),
        );
      },

      setTopics: (next) => {
        const st = get();
        const prev = st.topics;
        set({ topics: next, dirty: true });
        pushUndo('更新议题', () => set({ topics: prev, dirty: true }));
      },

      addTopic: (t) => {
        const st = get();
        if (!st.meeting) return null;
        const prev = st.topics;
        const topic: Topic = {
          ...t,
          id: t.id ?? newId(),
          meetingId: st.meeting.id,
          order: prev.length,
          bullets: t.bullets ?? [],
          createdAt: Date.now(),
        };
        set({ topics: [...prev, topic], dirty: true });
        pushUndo('新增议题', () => set({ topics: prev, dirty: true }));
        return topic;
      },

      updateTopic: (id, patch) => {
        const st = get();
        const prev = st.topics;
        set({ topics: prev.map((t) => (t.id === id ? { ...t, ...patch } : t)), dirty: true });
        pushUndo('编辑议题', () => set({ topics: prev, dirty: true }));
      },

      removeTopic: (id) => {
        const st = get();
        const prev = st.topics;
        const next = prev
          .filter((t) => t.id !== id)
          .map((t, i) => ({ ...t, order: i }));
        set({ topics: next, dirty: true });
        pushUndo('删除议题', () => set({ topics: prev, dirty: true }));
      },

      moveTopic: (id, dir) => {
        const st = get();
        const prev = st.topics;
        const idx = prev.findIndex((t) => t.id === id);
        const target = idx + dir;
        if (idx < 0 || target < 0 || target >= prev.length) return;
        const next = [...prev];
        const [item] = next.splice(idx, 1);
        next.splice(target, 0, item);
        set({ topics: next.map((t, i) => ({ ...t, order: i })), dirty: true });
        pushUndo('调整议题顺序', () => set({ topics: prev, dirty: true }));
      },

      setDecisions: (next) => {
        const st = get();
        const prev = st.decisions;
        set({ decisions: next, dirty: true });
        pushUndo('更新决议', () => set({ decisions: prev, dirty: true }));
      },

      addDecision: (d) => {
        const st = get();
        if (!st.meeting) return null;
        const prev = st.decisions;
        const item: Decision = {
          ...d,
          id: d.id ?? newId(),
          meetingId: st.meeting.id,
          order: prev.length,
          createdAt: Date.now(),
        };
        set({ decisions: [...prev, item], dirty: true });
        pushUndo('新增决议', () => set({ decisions: prev, dirty: true }));
        return item;
      },

      updateDecision: (id, patch) => {
        const st = get();
        const prev = st.decisions;
        set({ decisions: prev.map((d) => (d.id === id ? { ...d, ...patch } : d)), dirty: true });
        pushUndo('编辑决议', () => set({ decisions: prev, dirty: true }));
      },

      removeDecision: (id) => {
        const st = get();
        const prev = st.decisions;
        set({ decisions: prev.filter((d) => d.id !== id), dirty: true });
        pushUndo('删除决议', () => set({ decisions: prev, dirty: true }));
      },

      setActionItems: (next) => {
        const st = get();
        const prev = st.actionItems;
        set({ actionItems: next, dirty: true });
        pushUndo('更新待办', () => set({ actionItems: prev, dirty: true }));
      },

      addActionItem: (a) => {
        const st = get();
        if (!st.meeting) return null;
        const prev = st.actionItems;
        const item: ActionItem = {
          ...a,
          id: a.id ?? newId(),
          meetingId: st.meeting.id,
          createdAt: Date.now(),
        };
        set({ actionItems: [...prev, item], dirty: true });
        pushUndo('新增待办', () => set({ actionItems: prev, dirty: true }));
        return item;
      },

      updateActionItem: (id, patch) => {
        const st = get();
        const prev = st.actionItems;
        set({ actionItems: prev.map((a) => (a.id === id ? { ...a, ...patch } : a)), dirty: true });
        pushUndo('编辑待办', () => set({ actionItems: prev, dirty: true }));
      },

      removeActionItem: (id) => {
        const st = get();
        const prev = st.actionItems;
        set({ actionItems: prev.filter((a) => a.id !== id), dirty: true });
        pushUndo('删除待办', () => set({ actionItems: prev, dirty: true }));
      },

      /* ==================== 撤销 ==================== */

      undo: () => {
        const cmd = undoStack.pop();
        if (!cmd) return false;
        cmd.undo();
        set({ undoDepth: undoStack.length, undoLabel: undoStack[undoStack.length - 1]?.label ?? null, dirty: true });
        return true;
      },

      canUndo: () => undoStack.length > 0,
    };
  }),
);

/* ==================== 供外部使用的便捷选择器 ==================== */

/** 订阅单行发言（行组件用，避免整表重渲染） */
export const selectUtterance = (id: string) => (s: MeetingState): Utterance | undefined => s.uttMap[id];

/** 订阅 id 列表（列表容器用） */
export const selectUtteranceIds = (s: MeetingState): string[] => s.utteranceIds;

/** 按 id 找参会人 */
export function findSpeaker(participants: Participant[], id: string | null): Participant | undefined {
  if (!id) return undefined;
  return participants.find((p) => p.id === id);
}

/** 取发言人展示名（未归属 → 「未知发言人」） */
export function speakerNameOf(participants: Participant[], id: string | null): string {
  return findSpeaker(participants, id)?.name ?? '未知发言人';
}

/** 便于外部只读访问当前会议（非 hook 场景） */
export const meetingStoreApi = useMeetingStore;

/** 优先级排序权重（导出/展示用） */
export const PRIORITY_WEIGHT: Record<ActionPriority, number> = { P0: 0, P1: 1, P2: 2 };

/** 状态排序权重 */
export const STATUS_WEIGHT: Record<ActionStatus, number> = { todo: 0, done: 1 };
