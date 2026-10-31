/**
 * 语音识别引擎统一出口。
 *
 * 三档能力（PRD §5.1 降级矩阵）：
 * - L0 `web-speech`  ：浏览器实时识别（8s 探活通过）
 * - L1 `record-only` ：仅录音（无识别能力 / 探活失败），支持粘贴外部转录
 * - L2 `manual`      ：手动录入（非安全上下文 / 麦克风不可用）
 *
 * ★ 探活顺序（硬性要求）：
 *   ① `!isSecureContext` → L2
 *   ② 麦克风不可用 → L2
 *   ③ 无 SpeechRecognition 构造器 → L1
 *   ④ `probeWebSpeech(8000)` 失败 → L1，成功 → L0
 *   探活必须在 `getUserMedia` **之后**调用，避免二次弹权限框。
 */
import type { LangCode, SpeechLevel, SpeechMode, UtteranceSource } from '@/types/models';
import { WebSpeechProvider, getSpeechRecognitionCtor } from './WebSpeechProvider';
import { ManualProvider, RecordOnlyProvider } from './FallbackProviders';
import { CloudAsrProvider } from './CloudAsrProvider';
import {
  isTencentConfigured,
  type TencentAsrConfig,
} from '@/core/asr/tencent';

/** Provider → 会话的事件回调集合 */
export interface SpeechEventHandlers {
  /** interim 文本（灰色斜体）；由 session 以 200ms 节流写入独立 store 字段，**绝不进 uttMap** */
  onInterim(text: string, atMs: number): void;
  /** final 文本：落一条 Utterance */
  onFinal(text: string, atMs: number, confidence?: number, source?: UtteranceSource): void;
  /** 非致命信息提示（如已自动重启、已进入某模式） */
  onNotice(msg: string): void;
  /** 级别切换：0=实时识别 1=仅录音 2=手动；**任何降级都必须上报，永不静默失败** */
  onLevelChange(level: SpeechLevel, reason: string): void;
  /** 自动重启次数（首次重启时提示「文本未丢失」） */
  onAutoRestart(times: number): void;
}

/** 识别 Provider 统一契约 */
export interface ISpeechProvider {
  readonly level: SpeechLevel;
  readonly mode: SpeechMode;
  /** UI 徽标文案 */
  readonly label: string;
  /** 启动；stream 为 null 时（L1/L2）不采集 */
  start(stream: MediaStream | null): Promise<void>;
  stop(): void;
  pause(): void;
  resume(): void;
  setLang(lang: LangCode): void;
  /** 手动文本注入：L2 主路径 / L1 粘贴外部转录；L0 收到后照样落 Utterance(source='manual') */
  pushManualText(text: string, atMs: number): void;
  destroy(): void;
}

/** 工厂入参 */
export interface CreateSpeechOptions {
  lang: LangCode;
  /** 探活超时，默认 8000ms */
  probeMs?: number;
  /** 麦克风是否可用（由调用方在 getUserMedia 之后传入）；默认 true */
  micOk?: boolean;
  /** 腾讯云实时语音识别凭证；提供且齐全时优先走云端实时转写（L0） */
  asrConfig?: TencentAsrConfig | null;
}

/** §7.7 文案（与 core/repo 的 ERR_TEXT 保持一致） */
const TEXT_INSECURE = '当前不是 HTTPS 或 localhost，浏览器禁止访问麦克风，请使用本地运行或部署到 HTTPS';
const TEXT_ASR_UNAVAILABLE = '浏览器不支持实时语音识别，已切换为「录音模式」，会后转为文字';
const TEXT_ASR_NETWORK = '识别服务暂时不可用，已切换为「录音模式」';
const TEXT_MIC_UNAVAILABLE = '麦克风不可用，已切换为本地手动模式，可直接录入或粘贴文本';

/**
 * 8 秒探活：判断 Web Speech 是否真的可用。
 *
 * - 拿到任意非空 transcript → true
 * - `network | service-not-allowed | not-allowed | audio-capture` → 立即 false
 * - 超时仍无结果 → false
 * - `no-speech` / `aborted` 视为噪声，不构成失败
 */
export async function probeWebSpeech(ms = 8000): Promise<boolean> {
  const SR = getSpeechRecognitionCtor();
  if (!SR || !window.isSecureContext) return false;

  let rec: MMSpeechRecognition;
  try {
    rec = new SR();
  } catch {
    return false;
  }
  rec.lang = 'zh-CN';
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer = 0;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      try {
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        rec.stop();
      } catch {
        /* 忽略：未启动 / 已停止时的抛错 */
      }
      resolve(ok);
    };
    timer = window.setTimeout(() => finish(false), ms);
    rec.onresult = (e: MMSpeechResultEvent): void => {
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const t = String(e.results[i]?.[0]?.transcript ?? '').trim();
        if (t) {
          finish(true);
          return;
        }
      }
    };
    rec.onerror = (e: MMSpeechErrorEvent): void => {
      const code = e?.error ?? 'unknown';
      if (code === 'network' || code === 'service-not-allowed' || code === 'not-allowed' || code === 'audio-capture') {
        finish(false);
      }
    };
    try {
      rec.start();
    } catch {
      finish(false);
    }
  });
}

/**
 * 工厂：先判环境 → 再 8s 探活 → 产出 L0 / L1 / L2 Provider。
 * 每次等级判定都会回调 `onLevelChange`，保证 UI 有话说。
 */
export async function createSpeechProvider(
  handlers: SpeechEventHandlers,
  opts: CreateSpeechOptions,
): Promise<ISpeechProvider> {
  const probeMs = opts.probeMs ?? 8000;
  const micOk = opts.micOk ?? true;

  // ① 非安全上下文：麦克风与识别都不可用 → L2
  if (!window.isSecureContext) {
    handlers.onLevelChange(2, TEXT_INSECURE);
    return new ManualProvider(handlers);
  }
  // ② 麦克风拿不到 → L2
  if (!micOk) {
    handlers.onLevelChange(2, TEXT_MIC_UNAVAILABLE);
    return new ManualProvider(handlers);
  }
  // ②.5 腾讯云 ASR 凭证齐全 → 优先走云端实时转写（L0，大陆网络可用）
  if (isTencentConfigured(opts.asrConfig)) {
    handlers.onLevelChange(0, '已接入腾讯云实时语音识别');
    return new CloudAsrProvider(handlers, opts.asrConfig, opts.lang);
  }
  // ③ 没有识别构造器 → L1
  if (!getSpeechRecognitionCtor()) {
    handlers.onLevelChange(1, TEXT_ASR_UNAVAILABLE);
    return new RecordOnlyProvider(handlers);
  }
  // ④ 8 秒探活
  const ok = await probeWebSpeech(probeMs);
  if (!ok) {
    handlers.onLevelChange(1, TEXT_ASR_NETWORK);
    return new RecordOnlyProvider(handlers);
  }
  handlers.onLevelChange(0, '');
  return new WebSpeechProvider(handlers, opts.lang);
}

export { getSpeechRecognitionCtor, WebSpeechProvider, RecordOnlyProvider, ManualProvider, CloudAsrProvider };
