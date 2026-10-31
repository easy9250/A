/// <reference types="vite/client" />

/**
 * 全局类型补充声明。
 *
 * ★ 重要约定：本项目 **不使用** `@types/dom-speech-recognition`。
 * 新版 TypeScript 的 `lib.dom.d.ts` 已开始收录 `SpeechRecognition` 相关类型，
 * 两套全局声明会触发 `Duplicate identifier`。因此本文件内所有 Speech 相关类型
 * 统一加 `MM` 前缀（`MMSpeech*`），彻底避开与 lib.dom 的命名冲突。
 *
 * 使用方式（在业务代码里）：
 *   const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
 *   if (SR) { const rec = new (SR as MMSpeechRecognitionCtor)(); ... }
 */

/** 单条识别候选 */
interface MMSpeechAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

/** 一个识别结果（可能包含多个候选） */
interface MMSpeechResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(i: number): MMSpeechAlternative;
  [i: number]: MMSpeechAlternative;
}

/** 结果列表 */
interface MMSpeechResultList {
  readonly length: number;
  item(i: number): MMSpeechResult;
  [i: number]: MMSpeechResult;
}

/** result 事件（isFinal 区分 interim / final） */
interface MMSpeechResultEvent extends Event {
  readonly resultIndex: number;
  readonly results: MMSpeechResultList;
}

/** 语音识别错误码（与规范一致，额外允许 unknown 兜底） */
type MMSpeechErrorCode =
  | 'no-speech'
  | 'aborted'
  | 'audio-capture'
  | 'network'
  | 'not-allowed'
  | 'service-not-allowed'
  | 'bad-grammar'
  | 'language-not-supported'
  | 'unknown';

/** error 事件 */
interface MMSpeechErrorEvent extends Event {
  readonly error: MMSpeechErrorCode;
  readonly message: string;
}

/** 事件名 → 事件对象映射，供 addEventListener 精确推导 */
interface MMSpeechRecognitionEventMap {
  result: MMSpeechResultEvent;
  error: MMSpeechErrorEvent;
  end: Event;
  start: Event;
  audiostart: Event;
  audioend: Event;
  speechend: Event;
  nomatch: Event;
}

/** SpeechRecognition 实例 */
declare class MMSpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  grammars: unknown;
  constructor();
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: MMSpeechResultEvent) => void) | null;
  onerror: ((e: MMSpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onaudioend: (() => void) | null;
  onspeechend: (() => void) | null;
  onnomatch: (() => void) | null;
  addEventListener<K extends keyof MMSpeechRecognitionEventMap>(
    type: K,
    listener: (e: MMSpeechRecognitionEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof MMSpeechRecognitionEventMap>(
    type: K,
    listener: (e: MMSpeechRecognitionEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
}

/** SpeechRecognition 构造器类型 */
type MMSpeechRecognitionCtor = new () => MMSpeechRecognition;

interface Window {
  /** 标准构造器（Chrome/Edge） */
  SpeechRecognition?: MMSpeechRecognitionCtor;
  /** WebKit 前缀构造器（Safari/旧 Chrome） */
  webkitSpeechRecognition?: MMSpeechRecognitionCtor;
  /** CDN 兜底方案下注入的 CloudBase 全局对象 */
  cloudbase?: unknown;
}

/** 自定义环境变量（与 .env.example 对应） */
interface ImportMetaEnv {
  readonly VITE_CLOUDBASE_ENV?: string;
  readonly VITE_CLOUDBASE_REGION?: string;
  readonly VITE_ENABLE_CLOUD?: string;
  /** 腾讯云实时语音识别凭证（可选；也可在设置中填写） */
  readonly VITE_TENCENT_ASR_SECRET_ID?: string;
  readonly VITE_TENCENT_ASR_SECRET_KEY?: string;
  readonly VITE_TENCENT_ASR_APP_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
