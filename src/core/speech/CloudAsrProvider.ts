/**
 * L0 实时识别 Provider —— 腾讯云实时语音识别（WebSocket）。
 *
 * 作为 L0 实时转写的替代源，用于浏览器原生 Web Speech 在大陆网络不可达的场景。
 * 连接成功即 level 0；连接/鉴权/识别失败一律降级到 L1（录音模式），并经
 * `onLevelChange` 上报（永不静默失败）。录音本身由 MediaController 负责，本 Provider
 * 只负责识别，因此降级后仍可继续录音与粘贴外部转录。
 *
 * 降级链路（与 useSpeechSession 的 onLevelChange 协同）：
 *   - 本 Provider 调用 onLevelChange(1, reason) → 会话层会把 provider 换成 RecordOnlyProvider；
 *   - 速记会话（useQuickSession）的 onLevelChange 仅更新 UI，Provider 仍在本实例（已停收）。
 */
import type { LangCode, SpeechLevel, SpeechMode, UtteranceSource } from '@/types/models';
import type { ISpeechProvider, SpeechEventHandlers } from './index';
import { mediaController } from '@/core/audio/MediaController';
import {
  TencentAsrClient,
  tencentEngineForLang,
  type TencentAsrConfig,
  type TencentAsrHandlers,
} from '@/core/asr/tencent';

/** 连接超时（ms） */
const CONNECT_TIMEOUT_MS = 8000;

/**
 * 腾讯云实时识别 Provider。
 */
export class CloudAsrProvider implements ISpeechProvider {
  readonly level: SpeechLevel = 0;
  readonly mode: SpeechMode = 'cloud-asr';
  readonly label = '实时识别中(腾讯云)';

  private handlers: SpeechEventHandlers;
  private config: TencentAsrConfig;
  private lang: LangCode;

  private client: TencentAsrClient | null = null;
  /** 停止 PCM 抽取的回调（来自 mediaController.startPcmTap） */
  private stopPcm: (() => void) | null = null;
  private degraded = false;
  private destroyed = false;
  private running = false;

  constructor(handlers: SpeechEventHandlers, config: TencentAsrConfig, lang: LangCode) {
    this.handlers = handlers;
    this.config = config;
    this.lang = lang;
  }

  async start(_stream: MediaStream | null = null): Promise<void> {
    if (this.destroyed || this.degraded) return;
    this.running = true;
    const asrHandlers: TencentAsrHandlers = {
      onInterim: (text) => {
        if (this.degraded || this.destroyed) return;
        this.handlers.onInterim(text, Date.now());
      },
      onFinal: (text) => {
        if (this.degraded || this.destroyed) return;
        this.handlers.onFinal(text, Date.now(), undefined, 'asr' as UtteranceSource);
      },
      onError: (code, msg) => {
        this.degrade(`腾讯云识别出错（${code}）：${msg}，已切换为「录音模式」`);
      },
      onOpen: () => {
        /* 连接成功，UI 已由 level=0 反映 */
      },
    };

    try {
      const client = new TencentAsrClient(this.config, asrHandlers);
      this.client = client;
      await client.connect({
        engineModelType: tencentEngineForLang(this.lang),
        needVad: true,
        timeoutMs: CONNECT_TIMEOUT_MS,
      });
    } catch {
      // 连接/鉴权失败：降级 L1，录音继续（由 MediaController 负责）
      this.degrade('腾讯云实时识别连接失败，已切换为「录音模式」，会后可将外部转录粘贴进来');
      return;
    }

    // 连接成功：从麦克风抽取 16k PCM 喂给 WS
    try {
      this.stopPcm = mediaController.startPcmTap((pcm) => this.client?.sendPcm(pcm)) ?? null;
    } catch {
      this.stopPcm = null;
    }
  }

  stop(): void {
    this.running = false;
    this.detach();
    this.client?.stop();
    this.client = null;
  }

  pause(): void {
    if (!this.running) return;
    // 暂停：停止音频流（录音由 MediaController 一并暂停），保留非 degraded 以便 resume 重连
    this.detach();
    this.client?.stop();
    this.client = null;
  }

  resume(): void {
    if (!this.running || this.destroyed || this.degraded) return;
    void this.start(mediaController.stream);
  }

  setLang(lang: LangCode): void {
    this.lang = lang;
    // 语言切换需要重启连接才能生效；若已连接，触发一次重连
    if (this.client && !this.degraded) {
      this.pause();
      this.resume();
    }
  }

  /** 手动补录：照常落一条 source='manual' 的发言 */
  pushManualText(text: string, atMs: number): void {
    const clean = String(text ?? '').trim();
    if (!clean) return;
    this.handlers.onFinal(clean, atMs, undefined, 'manual' as UtteranceSource);
  }

  destroy(): void {
    this.destroyed = true;
    this.running = false;
    this.detach();
    this.client?.destroy();
    this.client = null;
  }

  /* ==================== 内部实现 ==================== */

  private detach(): void {
    this.stopPcm?.();
    this.stopPcm = null;
  }

  private degrade(reason: string): void {
    if (this.degraded || this.destroyed) return;
    this.degraded = true;
    this.detach();
    this.client?.destroy();
    this.client = null;
    this.handlers.onLevelChange(1, reason);
  }
}

export default CloudAsrProvider;
