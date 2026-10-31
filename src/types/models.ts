/**
 * 数据模型 —— 单一事实来源（Single Source of Truth）。
 * 所有模块、所有导出格式、云端与本地两条链路都以此处定义为准。
 */

/** 当前数据结构版本号；JSON 导入时做兼容校验 */
export const SCHEMA_VERSION = 1;

/** 会议状态机：idle → active ⇄ paused → ended */
export type MeetingStatus = 'idle' | 'active' | 'paused' | 'ended';

/** 实时 ASR 级别（对应 PRD §5.1 降级矩阵）：0=实时识别 1=仅录音 2=手动记录 */
export type SpeechLevel = 0 | 1 | 2;

/** 本次会议实际采用的识别模式 */
export type SpeechMode = 'web-speech' | 'record-only' | 'manual' | 'cloud-asr';

/** 云端探测状态机 */
export type CloudStatus = 'probing' | 'cloud' | 'local';

/** 发言来源：asr=机器识别 / manual=手动录入或粘贴 / edited=用户改过文本 */
export type UtteranceSource = 'asr' | 'manual' | 'edited';

/** 结构化产出来源：ai=CloudBase 大模型 / rule=本地规则引擎 / manual=用户手建 */
export type Origin = 'ai' | 'rule' | 'manual';

/** 待办优先级 */
export type ActionPriority = 'P0' | 'P1' | 'P2';

/** 待办状态 */
export type ActionStatus = 'todo' | 'done';

/** 打点类型（P1-07）；直接挂在 Utterance 上，避免新增实体 */
export type MarkerKind = 'important' | 'question' | 'followup';

/** 识别语言 */
export type LangCode = 'zh-CN' | 'en-US';

/** 会议主实体 */
export interface Meeting {
  id: string;
  /** 云端 mm_meetings._id（同步成功后回填） */
  cloudId?: string;
  title: string;
  /** 云端 openid；本地模式下固定为 'local' */
  ownerId: string;
  /** 首次开始的 epoch ms（UTC） */
  startedAt: number;
  endedAt: number | null;
  /** 累计「活动」时长，不含暂停 */
  durationMs: number;
  status: MeetingStatus;
  mode: SpeechMode;
  lang: LangCode;
  /** 是否产出过录音 */
  hasAudio: boolean;
  /** IndexedDB audio store 主键 */
  audioLocalKey?: string;
  /** 云端音频地址 */
  audioUrl?: string;
  /** 反范式检索字段：参会人名 + 全部发言正文拼接（截断 20000 字），由 LocalRepository 维护 */
  searchBlob: string;
  utteranceCount: number;
  schemaVersion: number;
  createdAt: number;
  updatedAt: number;
}

/** 参会人；「未知发言人」为系统保留项，id 固定为 'unknown' */
export interface Participant {
  id: string;
  meetingId: string;
  name: string;
  /** 主持人 / 记录人 / 旁听 … */
  role?: string;
  /** 0..7 → SPEAKER_COLORS */
  colorIndex: number;
  /** 头像条顺序，同时决定 Ctrl+N 的数字 */
  order: number;
  createdAt: number;
}

/** 单条发言 */
export interface Utterance {
  id: string;
  meetingId: string;
  /** 单调递增，从 1 开始；用于增量写与时间轴定位 */
  seq: number;
  /** null → 渲染为「未知发言人」 */
  speakerId: string | null;
  text: string;
  /** 相对会议开始的「活动」毫秒 */
  startMs: number;
  endMs: number;
  source: UtteranceSource;
  /** 仅 asr 有 */
  confidence?: number;
  /** 手录 / 编辑的恒为 true */
  isFinal: boolean;
  marker?: MarkerKind | null;
  starred: boolean;
  createdAt: number;
}

/** 议题分段 */
export interface Topic {
  id: string;
  meetingId: string;
  order: number;
  title: string;
  summary?: string;
  /** 可编辑要点列表 */
  bullets: string[];
  /** 若被删除则渲染时按 seq 回退 */
  startUtteranceId?: string;
  endUtteranceId?: string;
  origin: Origin;
  createdAt: number;
}

/** 决议 */
export interface Decision {
  id: string;
  meetingId: string;
  content: string;
  /** 溯源 ≥1 条 */
  sourceUtteranceIds: string[];
  order: number;
  /** 用户勾选确认 */
  confirmed: boolean;
  origin: Origin;
  createdAt: number;
}

/** 待办事项 */
export interface ActionItem {
  id: string;
  meetingId: string;
  content: string;
  assigneeId?: string | null;
  /** 'YYYY-MM-DD' */
  dueDate?: string | null;
  priority: ActionPriority;
  status: ActionStatus;
  sourceUtteranceIds: string[];
  origin: Origin;
  createdAt: number;
}

/** JSON 导出 / 导入的顶层结构；四种导出格式的共同数据源 */
export interface MeetingSnapshot {
  schemaVersion: number;
  exportedAt: number;
  meeting: Meeting;
  participants: Participant[];
  utterances: Utterance[];
  topics: Topic[];
  decisions: Decision[];
  actionItems: ActionItem[];
}

/** 历史列表用轻量结构：Meeting 本身 + 派生计数 */
export interface MeetingSummary {
  meeting: Meeting;
  participants: Pick<Participant, 'id' | 'name' | 'colorIndex'>[];
  decisionCount: number;
  actionCount: number;
  openActionCount: number;
  topicCount: number;
  /** 搜索命中片段（已高亮 <mark>） */
  hitSnippet?: string;
}

/** 系统保留的「未知发言人」参会人 id */
export const UNKNOWN_SPEAKER_ID = 'unknown';

/** 参会人上限（不含「未知发言人」） */
export const MAX_PARTICIPANTS = 12;

/** searchBlob 截断长度 */
export const SEARCH_BLOB_LIMIT = 20000;

/** 本地模式下的 ownerId */
export const LOCAL_OWNER_ID = 'local';
