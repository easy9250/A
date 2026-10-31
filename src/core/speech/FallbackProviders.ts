/**
 * 降级 Provider：
 * - `RecordOnlyProvider`（L1 仅录音）：不产出文本，但持续录音；支持粘贴外部转录。
 * - `ManualProvider`（L2 手动）：主区切换为手动输入，逐条落 Utterance(source='manual')。
 *
 * 两者同文件实现，共享基类；与 L0 实现同一套 `ISpeechProvider` 契约，UI 零分支。
 */
import type { LangCode, SpeechLevel, SpeechMode, UtteranceSource } from '@/types/models';
import type { ISpeechProvider, SpeechEventHandlers } from './index';

/** 降级 Provider 公共基类 */
abstract class BaseFallbackProvider implements ISpeechProvider {
  abstract readonly level: SpeechLevel;
  abstract readonly mode: SpeechMode;
  abstract readonly label: string;

  /** 启动后的一次性说明（进入 UI 提示条 / toast） */
  protected abstract readonly startNotice: string;

  protected handlers: SpeechEventHandlers;
  private paused = false;
  private destroyed = false;

  constructor(handlers: SpeechEventHandlers) {
    this.handlers = handlers;
  }

  async start(_stream: MediaStream | null = null): Promise<void> {
    this.destroyed = false;
    this.paused = false;
    if (this.startNotice) this.handlers.onNotice(this.startNotice);
  }

  stop(): void {
    this.paused = false;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  setLang(_lang: LangCode): void {
    /* 降级模式不做识别，语言切换无副作用 */
  }

  /** L1/L2 的主路径：文本直接落 Utterance(source='manual') */
  pushManualText(text: string, atMs: number): void {
    if (this.destroyed) return;
    const clean = String(text ?? '').trim();
    if (!clean) return;
    this.handlers.onFinal(clean, atMs, undefined, 'manual' as UtteranceSource);
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** 供 UI 判断是否处于暂停 */
  isPaused(): boolean {
    return this.paused;
  }
}

/**
 * L1 —— 仅录音模式。
 * 麦克风与录音由 MediaController 负责，本 Provider 只负责「粘贴外部转录」的注入通道。
 */
export class RecordOnlyProvider extends BaseFallbackProvider {
  readonly level: SpeechLevel = 1;
  readonly mode: SpeechMode = 'record-only';
  readonly label = '录音模式';
  protected readonly startNotice = '已切换为「录音模式」：全程录音不中断，会后可将外部转录粘贴进来';
}

/**
 * L2 —— 本地手动模式。
 * 常见于：非安全上下文（非 HTTPS / 非 localhost）、麦克风不可用。
 */
export class ManualProvider extends BaseFallbackProvider {
  readonly level: SpeechLevel = 2;
  readonly mode: SpeechMode = 'manual';
  readonly label = '本地模式（手动）';
  protected readonly startNotice = '当前为本地手动模式，请在下方文本框录入发言，或粘贴外部转录';
}
