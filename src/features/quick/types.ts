/**
 * 速记会话（Quick Session）领域类型。
 *
 * 该模块是「笔记 + 语音并行记录、结束自动整合」功能的数据契约，
 * 与 src/types/models.ts 解耦，仅在整合阶段映射回 MeetingSnapshot。
 */
import type { MeetingSnapshot, SpeechLevel } from '@/types/models';
import type { StructResult } from '@/core/struct';

/** 会话阶段机：idle（未开始） → active（记录中） → done（已生成总结） */
export type QuickPhase = 'idle' | 'active' | 'done';

/** 会话条目：语音转写 与 手动文字笔记 共用一条时间轴 */
export interface SessionEntry {
  id: string;
  /** 'voice' = 语音转写；'note' = 手动文字笔记 */
  kind: 'voice' | 'note';
  text: string;
  /** 相对会话开始的毫秒（用于时间轴定位与排序） */
  relMs: number;
  /** 墙钟时间，用于展示 */
  createdAt: number;
  /** 仅 voice 有：asr = 机器识别 / manual = 手动补录 */
  source?: 'asr' | 'manual';
}

/** 结束会话后输出的关键统计信息 */
export interface SessionStats {
  /** 会话总时长（毫秒） */
  durationMs: number;
  /** 笔记条数 */
  noteCount: number;
  /** 笔记总字数（按字符计，贴合中文习惯） */
  noteChars: number;
  /** 语音转写段数 */
  voiceSegments: number;
  /** 语音转写字数 */
  voiceChars: number;
  /** 总条目数（笔记 + 语音） */
  entryCount: number;
  /** 结构化议题数 */
  topicCount: number;
  /** 结构化决议数 */
  decisionCount: number;
  /** 待办总数 */
  actionCount: number;
  /** 未完成待办数 */
  openActionCount: number;
}

/** 结束会话后的整合结果（唯一对外产物） */
export interface QuickSessionResult {
  /** 可导出 / 持久化的完整快照 */
  snapshot: MeetingSnapshot;
  /** 关键统计 */
  stats: SessionStats;
  /** 是否真实产生过录音音频 */
  hasAudio: boolean;
}

/** 顶部降级 / 提示条 */
export interface QuickBanner {
  msg: string;
  kind: 'info' | 'warning' | 'error' | 'success';
}

/** 仅类型占位：让 useQuickSession 的返回类型可被引用 */
export type QuickSpeechLevel = SpeechLevel;
