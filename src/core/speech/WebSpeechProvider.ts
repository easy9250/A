/**
 * L0 实时识别 Provider —— 基于浏览器 Web Speech API（SpeechRecognition）。
 *
 * 关键实现点：
 * 1) `continuous = true` + `interimResults = true`；
 * 2) interim 与 final 分离：final 只处理 `isFinal` 且未处理过的索引（不重不漏）；
 * 3) `onend` 是 Chrome 的常态（静音一段时间后自动结束），300ms 后自动重启；
 * 4) 连续 3 次致命失败才降级（L1），且降级必须经 `onLevelChange` 上报（永不静默失败）。
 */
import type { LangCode, SpeechLevel, SpeechMode, UtteranceSource } from '@/types/models';
import type { ISpeechProvider, SpeechEventHandlers } from './index';

/** 取浏览器 SpeechRecognition 构造器（含 webkit 前缀）；无则 null */
export function getSpeechRecognitionCtor(): MMSpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

/** 视为「服务不可用」的错误码（会导致降级） */
const FATAL_ERRORS: MMSpeechErrorCode[] = ['network', 'service-not-allowed', 'not-allowed', 'audio-capture'];

/** 视为噪声的错误码：不构成失败 */
const NOISE_ERRORS: MMSpeechErrorCode[] = ['no-speech', 'aborted', 'bad-grammar', 'language-not-supported'];

/** onend 后重启延迟（§7.6 P0-03③） */
const RESTART_DELAY_MS = 300;

/** 连续失败多少次后降级 */
const MAX_FAIL_STREAK = 3;

/**
 * L0：Web Speech 实时识别。
 */
export class WebSpeechProvider implements ISpeechProvider {
  readonly level: SpeechLevel = 0;
  readonly mode: SpeechMode = 'web-speech';
  readonly label = '实时识别中';

  private handlers: SpeechEventHandlers;
  private lang: LangCode;
  private rec: MMSpeechRecognition | null = null;
  private running = false;
  private paused = false;
  private destroyed = false;
  private degraded = false;
  private restartTimer: number | null = null;
  private failStreak = 0;
  private restartTimes = 0;
  /** 本次会话已上报过的 final 结果索引（防止重复落库） */
  private emittedFinals: Set<number> = new Set();

  constructor(handlers: SpeechEventHandlers, lang: LangCode) {
    this.handlers = handlers;
    this.lang = lang;
  }

  /**
   * 启动识别。
   * @param _stream Web Speech 自取麦克风，与本应用的 MediaStream 并存，故此处仅作占位
   */
  async start(_stream: MediaStream | null = null): Promise<void> {
    this.destroyed = false;
    this.degraded = false;
    this.paused = false;
    this.running = true;
    this.failStreak = 0;
    this.beginSession();
  }

  /** 停止识别（不再自动重启） */
  stop(): void {
    this.running = false;
    this.paused = false;
    this.clearTimer();
    this.teardownRec();
  }

  /** 暂停（主动 stop，不触发自动重启） */
  pause(): void {
    if (!this.running) return;
    this.paused = true;
    this.clearTimer();
    this.teardownRec();
  }

  /** 继续 */
  resume(): void {
    if (!this.running) return;
    if (!this.paused) return;
    this.paused = false;
    this.emittedFinals.clear();
    this.beginSession();
  }

  /** 切换识别语言（立即生效于新会话；旧会话同步 lang 字段） */
  setLang(lang: LangCode): void {
    this.lang = lang;
    if (this.rec) this.rec.lang = lang;
  }

  /** 手动补录：L0 也照样落一条 source='manual' 的发言 */
  pushManualText(text: string, atMs: number): void {
    const clean = text.trim();
    if (!clean) return;
    this.handlers.onFinal(clean, atMs, undefined, 'manual' as UtteranceSource);
  }

  /** 销毁：abort 并清空定时器 */
  destroy(): void {
    this.destroyed = true;
    this.running = false;
    this.clearTimer();
    this.teardownRec(true);
  }

  /* ==================== 内部实现 ==================== */

  /** 建立一次识别会话 */
  private beginSession(): void {
    if (this.destroyed || this.degraded) return;
    const SR = getSpeechRecognitionCtor();
    if (!SR) {
      this.degrade('浏览器不支持实时语音识别，已切换为「录音模式」，会后转为文字');
      return;
    }
    this.teardownRec();
    let rec: MMSpeechRecognition;
    try {
      rec = new SR();
    } catch {
      this.degrade('浏览器不支持实时语音识别，已切换为「录音模式」，会后转为文字');
      return;
    }
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e: MMSpeechResultEvent): void => this.handleResult(e);
    rec.onerror = (e: MMSpeechErrorEvent): void => this.handleError(e);
    rec.onend = (): void => this.handleEnd();
    this.rec = rec;
    this.emittedFinals.clear();
    try {
      rec.start();
    } catch {
      // start 抛错（如已在运行）按一次失败计
      this.failStreak += 1;
      if (this.failStreak >= MAX_FAIL_STREAK) {
        this.degrade('识别服务暂时不可用，已切换为「录音模式」');
      } else {
        this.scheduleRestart();
      }
    }
  }

  /**
   * 处理结果事件。
   * ★ 从 `event.resultIndex` 起遍历，只上报 isFinal 且未上报过的项（不重不漏）。
   */
  private handleResult(e: MMSpeechResultEvent): void {
    if (this.destroyed || this.degraded) return;
    // 能拿到结果就说明服务可用，清空失败计数
    this.failStreak = 0;
    let interim = '';
    const now = Date.now();
    for (let i = e.resultIndex; i < e.results.length; i += 1) {
      const r = e.results[i];
      if (!r) continue;
      const alt = r[0];
      const text = String(alt?.transcript ?? '').trim();
      if (!text) continue;
      if (r.isFinal) {
        if (this.emittedFinals.has(i)) continue;
        this.emittedFinals.add(i);
        this.handlers.onFinal(text, now, typeof alt?.confidence === 'number' ? alt.confidence : undefined, 'asr');
      } else {
        interim = interim ? `${interim} ${text}` : text;
      }
    }
    if (interim) this.handlers.onInterim(interim, now);
  }

  /** 错误分级：噪声忽略；致命错误计数，连续 3 次降级 */
  private handleError(e: MMSpeechErrorEvent): void {
    if (this.destroyed || this.degraded) return;
    const code: MMSpeechErrorCode = e?.error ?? 'unknown';
    if (NOISE_ERRORS.includes(code)) return;
    if (FATAL_ERRORS.includes(code)) {
      this.failStreak += 1;
      if (this.failStreak >= MAX_FAIL_STREAK) {
        this.degrade(
          code === 'network'
            ? '识别服务暂时不可用，已切换为「录音模式」'
            : '无法访问麦克风或识别服务，已切换为「录音模式」',
        );
        return;
      }
      return;
    }
    // 其它未归类错误：按噪声处理，等待 onend 自然重启
  }

  /** onend：Chrome 常态，300ms 后自动重启 */
  private handleEnd(): void {
    if (this.destroyed || this.degraded || this.paused || !this.running) return;
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.restartTimer !== null) return;
    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = null;
      if (this.destroyed || this.degraded || this.paused || !this.running) return;
      this.restartTimes += 1;
      this.beginSession();
      this.handlers.onAutoRestart(this.restartTimes);
    }, RESTART_DELAY_MS);
  }

  /** 降级到 L1：通知外部（永不静默失败） */
  private degrade(reason: string): void {
    if (this.degraded) return;
    this.degraded = true;
    this.running = false;
    this.clearTimer();
    this.teardownRec();
    this.handlers.onLevelChange(1, reason);
  }

  private clearTimer(): void {
    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  /** 释放当前识别实例；abort=true 时立即中断，否则优雅 stop */
  private teardownRec(abort = false): void {
    const rec = this.rec;
    this.rec = null;
    if (!rec) return;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    try {
      if (abort) rec.abort();
      else rec.stop();
    } catch {
      /* 忽略：未启动时 stop 会抛错 */
    }
  }
}

export default WebSpeechProvider;
