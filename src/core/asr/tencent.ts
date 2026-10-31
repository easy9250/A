/**
 * 腾讯云实时语音识别（WebSocket）客户端。
 *
 * 职责：HMAC-SHA1 签名 → 建立 wss 连接 → 发送 16k / 16bit / 单声道 PCM 帧 → 解析 interim / final 结果。
 * 与本应用 `MediaController.startPcmTap` 产出的 PCM 完全匹配（16k 重采样已在采集侧完成）。
 *
 * ★ 签名算法（与官方 tencentcloud-speech-sdk-js 保持一致，已逐行核对）：
 *   签名原文 = `asr.cloud.tencent.com/asr/v2/<appid>?<按 key 升序排列的全部请求参数>`
 *   其中 appid 仅出现在 path，secretkey / signature 不进入签名原文。
 *   以 SecretKey 对原文做 HMAC-SHA1（UTF-8），再做 base64，得到 signature。
 *   最终 WebSocket 地址 = `wss://asr.cloud.tencent.com/asr/v2/<appid>?<排序参数>&signature=<urlencode(signature)>`。
 *
 * 响应（实时语音识别 v1 协议）：
 *   - code !== 0 → 错误（含鉴权失败 6002）
 *   - final === 1 → 整条音频流结束（仅在 stop 时触发）
 *   - result.slice_type === 0 → 一句话开始（通常无文本，忽略）
 *   - result.slice_type === 1 → 非稳态（识别中，可能变化）→ onInterim
 *   - result.slice_type === 2 → 稳态（一句话结束，不再变化）→ onFinal
 */

import type { LangCode } from '@/types/models';

/** 腾讯云 ASR 凭证 */
export interface TencentAsrConfig {
  secretId: string;
  secretKey: string;
  appId: string;
}

/** 客户端→会话的回调 */
export interface TencentAsrHandlers {
  /** 临时结果（一句话识别中，可能变化） */
  onInterim: (text: string) => void;
  /** 稳态结果（一句话结束，不再变化） */
  onFinal: (text: string) => void;
  /** 连接 / 鉴权 / 识别错误 */
  onError: (code: number | string, message: string) => void;
  /** 握手成功 */
  onOpen?: () => void;
}

const HOST = 'asr.cloud.tencent.com';
const PATH = '/asr/v2/';

/** 根据界面语言选择引擎模型 */
export function tencentEngineForLang(lang: LangCode): string {
  return lang === 'en-US' ? '16k_en' : '16k_zh';
}

/** 凭证是否齐全 */
export function isTencentConfigured(cfg: TencentAsrConfig | null | undefined): cfg is TencentAsrConfig {
  return Boolean(cfg && cfg.secretId && cfg.secretKey && cfg.appId);
}

/** ArrayBuffer → base64（浏览器全局 btoa，按字节 Latin1 编码） */
function base64FromBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** UUID-v4 风格唯一 voice_id */
function guid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Web Crypto HMAC-SHA1（与官方 SDK 的 CryptoJS.HmacSHA1 + btoa 结果一致） */
async function computeSignature(secretKey: string, signStr: string): Promise<string> {
  const enc = new TextEncoder();
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('当前环境不支持 Web Crypto，无法为腾讯云 ASR 生成签名');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signStr));
  return base64FromBuffer(sig);
}

/** 构造签名原文（不含 wss://） */
function buildSignString(appId: string, params: Record<string, string>): string {
  const keys = Object.keys(params).sort();
  const query = keys.map((k) => `${k}=${params[k]}`).join('&');
  return `${HOST}${PATH}${appId}?${query}`;
}

interface TencentAsrResponse {
  code: number;
  message: string;
  voice_id?: string;
  message_id?: string;
  final?: number;
  result?: {
    slice_type?: number;
    voice_text_str?: string;
    index?: number;
    word_list?: unknown[];
  };
}

/**
 * 腾讯云实时识别客户端。
 * 用法：new → connect() → 循环 sendPcm() → stop()/destroy()。
 */
export class TencentAsrClient {
  private ws: WebSocket | null = null;
  private readonly config: TencentAsrConfig;
  private readonly handlers: TencentAsrHandlers;
  private readonly voiceId: string;
  private closedByUs = false;

  constructor(config: TencentAsrConfig, handlers: TencentAsrHandlers) {
    this.config = config;
    this.handlers = handlers;
    this.voiceId = guid();
  }

  /** 建立连接；resolve 于握手成功，reject 于连接/鉴权失败 */
  async connect(opts?: { engineModelType?: string; needVad?: boolean; timeoutMs?: number }): Promise<void> {
    const engine = opts?.engineModelType ?? '16k_zh';
    const now = Math.floor(Date.now() / 1000);
    const params: Record<string, string> = {
      secretid: this.config.secretId,
      engine_model_type: engine,
      timestamp: String(now),
      expired: String(now + 24 * 3600),
      nonce: String(Math.floor(Math.random() * 1e9)),
      voice_id: this.voiceId,
      voice_format: '1', // 1 = PCM（16k/16bit/单声道）
      needvad: opts?.needVad === false ? '0' : '1',
    };

    const signStr = buildSignString(this.config.appId, params);
    const signature = await computeSignature(this.config.secretKey, signStr);
    const url =
      `wss://${HOST}${PATH}${this.config.appId}?` +
      Object.keys(params)
        .sort()
        .map((k) => `${k}=${params[k]}`)
        .join('&') +
      `&signature=${encodeURIComponent(signature)}`;

    await new Promise<void>((resolve, reject) => {
      if (typeof WebSocket === 'undefined') {
        reject(new Error('浏览器不支持 WebSocket'));
        return;
      }
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          this.ws?.close();
        } catch {
          /* 忽略 */
        }
        reject(new Error('腾讯云识别连接超时'));
      }, opts?.timeoutMs ?? 8000);

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        settled = true;
        window.clearTimeout(timeout);
        reject(e);
        return;
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        this.handlers.onOpen?.();
        resolve();
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        if (!this.closedByUs) this.handlers.onError('WS_ERROR', '与腾讯云识别服务的连接失败');
        reject(new Error('腾讯云识别 WebSocket 连接错误'));
      };
      ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev.data);
      ws.onclose = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        if (!this.closedByUs) this.handlers.onError('WS_CLOSED', '与腾讯云识别服务的连接已断开');
        reject(new Error('腾讯云识别 WebSocket 已关闭'));
      };
    });
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return; // 二进制帧是音频回声，忽略
    let resp: TencentAsrResponse;
    try {
      resp = JSON.parse(data) as TencentAsrResponse;
    } catch {
      return;
    }
    if (resp.code !== 0) {
      this.handlers.onError(resp.code, String(resp.message ?? '识别服务返回错误'));
      return;
    }
    // 整条音频流结束（仅 stop 时触发），无需处理文本
    if (resp.final === 1) return;
    const result = resp.result;
    if (!result) return;
    const text = String(result.voice_text_str ?? '').trim();
    if (!text) return;
    if (result.slice_type === 2) {
      this.handlers.onFinal(text);
    } else if (result.slice_type === 1) {
      this.handlers.onInterim(text);
    }
    // slice_type === 0（一句话开始）通常无文本，忽略
  }

  /** 发送一段 16k/16bit 单声道 PCM（Int16Array 或裸 ArrayBuffer） */
  sendPcm(pcm: Int16Array | ArrayBuffer): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(pcm);
    } catch {
      /* 忽略零星发送异常 */
    }
  }

  /** 通知服务端音频结束并等待最终回包后关闭 */
  stop(): void {
    const ws = this.ws;
    this.closedByUs = true;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'end' }));
      } catch {
        /* 忽略 */
      }
    }
    // 给服务端留出回 final 的时间
    window.setTimeout(() => {
      try {
        ws?.close();
      } catch {
        /* 忽略 */
      }
    }, 400);
  }

  /** 立即关闭（不等待回包） */
  destroy(): void {
    this.closedByUs = true;
    try {
      this.ws?.close();
    } catch {
      /* 忽略 */
    }
    this.ws = null;
  }
}
