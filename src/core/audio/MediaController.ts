/**
 * 音频 / 录音控制器（单例）。
 *
 * 职责：
 * 1) 麦克风采集：`init()` 取流，`switchDevice()` 在**同一个 MediaStream 对象内**换轨，
 *    保证 MediaRecorder 不中断（P0 录音连续性）；
 * 2) 录音：`startRec/pauseRec/resumeRec/stopRec`，`start(1000)` 分片，stop 时合成一个 Blob；
 * 3) 音量：AnalyserNode RMS（0..1），内部 rAF 采样，UI 侧每 ~66ms 取一次；
 * 4) 能量突变：500ms 一个窗口，同比 > 2.5 倍触发回调（P1-05，**只提示，绝不改写归属**）；
 * 5) 播放：`attachPlayer/loadAudio/seekToRelMs/play/pause`，供「时间码跳录音」使用。
 *
 * ★ 时间轴铁律（§7.2）：`startRec/pauseRec/resumeRec` 必须与
 *   `startMeeting/pauseMeeting/resumeMeeting` 成对调用，
 *   因此 utterance.startMs 可直接喂 `seekToRelMs(ms)`，无需任何偏移换算。
 */
import { MMError } from '@/core/repo';
import { toast } from '@/stores/useUiStore';

/** 能量突变事件（P1-05） */
export interface EnergySpike {
  /** 相对会议开始的「累计活动」毫秒（= 录音时间轴） */
  atMs: number;
  /** 突变倍数（当前窗口均值 / 上一窗口均值） */
  delta: number;
  /** 预留：候选发言人（本项目恒为 null，绝不自动改写归属） */
  suggestionId?: string | null;
}

/** 麦克风设备选项 */
export interface AudioDeviceOption {
  deviceId: string;
  label: string;
}

/** 录音产物 */
export interface RecResult {
  blob: Blob;
  size: number;
  mime: string;
}

/** MediaRecorder 候选 MIME（按优先级） */
const MIME_CANDIDATES: string[] = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

/** MediaRecorder 分片间隔（§7.6 K9） */
const REC_TIMESLICE_MS = 1000;

/** 能量判定窗口（§7.6 P1-05） */
const ENERGY_WINDOW_MS = 500;

/** 能量突变阈值：同比 > 2.5 倍 */
const ENERGY_RATIO = 2.5;

/** 能量判定最小 RMS：低于此值视为环境静音，不触发提示 */
const ENERGY_MIN_RMS = 0.02;

/** RMS → 展示电平的经验放大系数（人声 RMS 通常远小于 1） */
const LEVEL_GAIN = 1.8;

/**
 * 音频控制器。全局单例 `mediaController`。
 */
class MediaController {
  /** 当前麦克风流；切设备时保持同一个对象（只换 track） */
  public stream: MediaStream | null = null;

  /* ---------------- 音量分析 ---------------- */
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private timeData: Uint8Array = new Uint8Array(1024);
  private levelValue = 0;
  private rafId: number | null = null;

  /* ---------------- 录音 ---------------- */
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private recMime = 'audio/webm';
  private recState: 'idle' | 'recording' | 'paused' | 'stopped' = 'idle';
  /** 已累计的活动毫秒（与会议时钟同源） */
  private recElapsedMs = 0;
  /** 处于 recording 时的本次计时起点 */
  private recTickAt: number | null = null;
  private stopResolver: ((r: RecResult | null) => void) | null = null;

  /* ---------------- 能量突变 ---------------- */
  private spikeCbs: Set<(e: EnergySpike) => void> = new Set();
  private energyTimer: number | null = null;
  private windowSamples: number[] = [];
  private prevWindowAvg = 0;

  /* ---------------- 播放 ---------------- */
  private player: HTMLAudioElement | null = null;
  /** 由 ensurePlayer 兜底创建的元素（destroy 时负责从 DOM 移除） */
  private ownedPlayer: HTMLAudioElement | null = null;
  private playerUrl: string | null = null;
  private audioBlob: Blob | null = null;
  private pendingSeekSec: number | null = null;

  private deviceId = '';

  /* ---------------- 实时 ASR 用的原始 PCM 采集（16k/16bit/单声道） ---------------- */
  private pcmTap: ScriptProcessorNode | null = null;
  private pcmSilent: GainNode | null = null;
  private pcmSink: ((pcm: Int16Array) => void) | null = null;
  /** 重采样目标采样率（腾讯云实时识别要求 16k） */
  private static readonly PCM_RATE = 16000;

  /* ==================== 采集 ==================== */

  /**
   * 申请麦克风并建立音量分析链路。
   * @param deviceId 指定设备；留空使用系统默认
   * @throws MMError('INSECURE_CONTEXT' | 'MIC_NOT_FOUND' | 'MIC_DENIED')
   */
  async init(deviceId?: string): Promise<MediaStream> {
    if (!window.isSecureContext) {
      throw new MMError(
        'INSECURE_CONTEXT',
        '当前不是 HTTPS 或 localhost，浏览器禁止访问麦克风，请使用本地运行或部署到 HTTPS',
      );
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new MMError('MIC_NOT_FOUND', '未检测到可用的音频输入设备');
    }
    const audio: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    // 用 ideal 而非 exact：若持久化的 deviceId 失效/变化，浏览器回退默认设备，
    // 而非抛出 OverconstrainedError 被误判为「找不到麦克风」。
    if (deviceId) audio.deviceId = { ideal: deviceId };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    } catch (e) {
      const name = String((e as DOMException | undefined)?.name ?? '');
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new MMError('MIC_DENIED', '麦克风权限被拒绝，请在浏览器地址栏站点设置中允许后重试');
      }
      throw new MMError('MIC_NOT_FOUND', '未检测到可用的音频输入设备');
    }
    this.stream = stream;
    this.deviceId = deviceId || stream.getAudioTracks()[0]?.getSettings().deviceId || '';
    this.setupAnalyser(stream);
    this.startLoop();
    this.startEnergyTimer();
    return stream;
  }

  /**
   * 开始原始 PCM 采集（16k / 16bit / 单声道），供实时 ASR 使用。
   * 复用已建立的麦克风音频图：source → ScriptProcessor(重采样到 16k) → 静音 Gain → destination。
   * @returns 停止函数；若麦克风尚未初始化则返回 null
   */
  startPcmTap(cb: (pcm: Int16Array) => void): (() => void) | null {
    if (!this.audioCtx || !this.sourceNode) return null;
    this.stopPcmTap();
    this.pcmSink = cb;
    const proc = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.pcmTap = proc;
    this.connectPcmTap();
    return () => this.stopPcmTap();
  }

  /** 将 source → pcmTap → 静音增益 → destination 连好（设备切换后重连也用） */
  private connectPcmTap(): void {
    const proc = this.pcmTap;
    if (!proc || !this.audioCtx || !this.sourceNode) return;
    const ctx = this.audioCtx;
    proc.onaudioprocess = (ev: AudioProcessingEvent): void => {
      const input = ev.inputBuffer.getChannelData(0);
      const outLen = Math.max(1, Math.round((input.length * MediaController.PCM_RATE) / ctx.sampleRate));
      const out = new Int16Array(outLen);
      for (let i = 0; i < outLen; i += 1) {
        const idx = (i * ctx.sampleRate) / MediaController.PCM_RATE;
        const i0 = Math.floor(idx);
        const i1 = Math.min(input.length - 1, i0 + 1);
        const frac = idx - i0;
        let s = input[i0] * (1 - frac) + input[i1] * frac;
        if (s > 1) s = 1;
        else if (s < -1) s = -1;
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.pcmSink?.(out);
    };
    this.sourceNode.connect(proc);
    // 静音增益仅创建一次；设备切换后重连 source→proc 时复用，避免重复建链导致泄漏。
    if (!this.pcmSilent) {
      const silent = ctx.createGain();
      silent.gain.value = 0;
      proc.connect(silent);
      silent.connect(ctx.destination);
      this.pcmSilent = silent;
    }
  }

  /** 停止 PCM 采集并断开音频图 */
  stopPcmTap(): void {
    if (this.pcmTap) {
      try {
        this.sourceNode?.disconnect(this.pcmTap);
      } catch {
        /* 已断开 */
      }
      try {
        this.pcmTap.disconnect();
      } catch {
        /* 已断开 */
      }
      this.pcmTap.onaudioprocess = null;
      this.pcmTap = null;
    }
    if (this.pcmSilent) {
      try {
        this.pcmSilent.disconnect();
      } catch {
        /* 已断开 */
      }
      this.pcmSilent = null;
    }
    this.pcmSink = null;
  }

  /** 当前使用的设备 ID */
  getDeviceId(): string {
    return this.deviceId;
  }

  /** 枚举音频输入设备（未授权时 label 可能为空） */
  async listDevices(): Promise<AudioDeviceOption[]> {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') return [];
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const inputs = all.filter((d) => d.kind === 'audioinput');
      return inputs.map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `麦克风 ${i + 1}`,
      }));
    } catch {
      return [];
    }
  }

  /**
   * ★ 切换输入设备：在**同一个 MediaStream 对象内** removeTrack / addTrack，
   * MediaRecorder 不中断、不重启，历史录音保持连续。
   */
  async switchDevice(deviceId: string): Promise<void> {
    if (!this.stream) {
      this.deviceId = deviceId;
      return;
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new MMError('MIC_NOT_FOUND', '未检测到可用的音频输入设备');
    }
    let next: MediaStream;
    try {
      next = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (e) {
      const name = String((e as DOMException | undefined)?.name ?? '');
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new MMError('MIC_DENIED', '麦克风权限被拒绝，请在浏览器地址栏站点设置中允许后重试');
      }
      throw new MMError('MIC_NOT_FOUND', '未检测到可用的音频输入设备');
    }
    const nextTrack = next.getAudioTracks()[0];
    if (!nextTrack) {
      throw new MMError('MIC_NOT_FOUND', '未检测到可用的音频输入设备');
    }
    // 同一个 MediaStream 内换轨：recorder 绑定的仍是 this.stream，因此不中断
    for (const old of this.stream.getAudioTracks()) {
      this.stream.removeTrack(old);
      old.stop();
    }
    this.stream.addTrack(nextTrack);
    this.deviceId = deviceId;
    this.rebindSource(this.stream);
  }

  /* ==================== 录音 ==================== */

  /** 开始录音（MediaRecorder.start(1000) 分片） */
  startRec(): void {
    if (!this.stream) return;
    if (this.recorder && (this.recState === 'recording' || this.recState === 'paused')) return;
    if (typeof MediaRecorder === 'undefined') {
      toast.warning('当前浏览器不支持录音，已切换为手动模式');
      return;
    }
    const mime = MIME_CANDIDATES.find(
      (m) => typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(m),
    );
    let rec: MediaRecorder;
    try {
      rec = mime ? new MediaRecorder(this.stream, { mimeType: mime }) : new MediaRecorder(this.stream);
    } catch {
      try {
        rec = new MediaRecorder(this.stream);
      } catch {
        toast.warning('当前浏览器不支持录音，已切换为手动模式');
        return;
      }
    }
    this.recMime = rec.mimeType || mime || 'audio/webm';
    this.chunks = [];
    this.recElapsedMs = 0;
    this.recTickAt = null;
    rec.ondataavailable = (ev: BlobEvent): void => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
    };
    rec.onstop = (): void => this.finishStop();
    rec.onerror = (): void => {
      toast.error('录音中断，请检查麦克风后重试');
    };
    this.recorder = rec;
    this.recState = 'recording';
    this.recTickAt = Date.now();
    try {
      rec.start(REC_TIMESLICE_MS);
    } catch {
      this.recState = 'idle';
      this.recorder = null;
      toast.error('录音启动失败，请检查麦克风后重试');
    }
  }

  /** 暂停录音（与 pauseMeeting 成对调用） */
  pauseRec(): void {
    const rec = this.recorder;
    if (!rec || this.recState !== 'recording') return;
    this.accumulateRec();
    try {
      rec.pause();
      this.recState = 'paused';
    } catch {
      /* 浏览器不支持 pause 时降级为不暂停，时间轴仍以 recTickAt 为准 */
    }
  }

  /** 继续录音（与 resumeMeeting 成对调用） */
  resumeRec(): void {
    const rec = this.recorder;
    if (!rec) {
      // 尚未开始过录音（如恢复会议场景）：直接起录
      this.startRec();
      return;
    }
    if (this.recState !== 'paused') return;
    try {
      rec.resume();
      this.recState = 'recording';
      this.recTickAt = Date.now();
    } catch {
      this.recTickAt = Date.now();
    }
  }

  /** 停止录音并合成 Blob；无内容返回 null */
  async stopRec(): Promise<RecResult | null> {
    const rec = this.recorder;
    if (!rec || this.recState === 'idle') {
      this.recorder = null;
      return null;
    }
    this.accumulateRec();
    return new Promise<RecResult | null>((resolve) => {
      this.stopResolver = resolve;
      try {
        if (rec.state !== 'inactive') {
          rec.stop();
        } else {
          this.finishStop();
        }
      } catch {
        this.finishStop();
      }
      // 兜底：某些浏览器 onstop 不触发
      window.setTimeout(() => this.finishStop(), 1500);
    });
  }

  /** 录音是否已开始（无论 recording / paused） */
  isRecording(): boolean {
    return this.recState === 'recording' || this.recState === 'paused';
  }

  /** 录音时间轴当前毫秒（与会议 elapsedMs 同源） */
  recMs(): number {
    return this.recElapsedMs + (this.recTickAt ? Date.now() - this.recTickAt : 0);
  }

  /* ==================== 音量 / 能量 ==================== */

  /** AnalyserNode RMS，0..1；UI 侧每 ~66ms 取一次即可 */
  getLevel(): number {
    return this.levelValue;
  }

  /**
   * 注册能量突变回调（P1-05）。
   * ★ 只提示，绝不自动改写发言人归属。
   * @returns 取消订阅函数
   */
  onEnergySpike(cb: (e: EnergySpike) => void): () => void {
    if (!cb) return () => undefined;
    this.spikeCbs.add(cb);
    this.startEnergyTimer();
    return () => {
      this.spikeCbs.delete(cb);
    };
  }

  /* ==================== 播放 ==================== */

  /** 绑定 <audio> 元素（LivePage / ReviewPage 各自绑定自己的） */
  attachPlayer(el: HTMLAudioElement | null): void {
    if (!el) {
      this.player = null;
      return;
    }
    this.player = el;
    el.onloadedmetadata = (): void => {
      if (this.pendingSeekSec !== null) {
        try {
          el.currentTime = this.pendingSeekSec;
        } catch {
          /* 元数据未就绪时忽略 */
        }
        this.pendingSeekSec = null;
      }
    };
    if (this.playerUrl) {
      el.src = this.playerUrl;
      el.load();
    }
  }

  /**
   * 确保存在 <audio> 播放器。
   * 调用方（LivePage / ReviewPage）应显式 `attachPlayer(el)`；
   * 未显式绑定时这里兜底创建一个隐藏元素，保证「按名调用」的跨模块契约永不哑火。
   */
  private ensurePlayer(): HTMLAudioElement | null {
    if (this.player) return this.player;
    if (typeof document === 'undefined') return null;
    const el = document.createElement('audio');
    el.style.display = 'none';
    el.preload = 'auto';
    document.body.appendChild(el);
    this.ownedPlayer = el;
    this.attachPlayer(el);
    return el;
  }

  /**
   * 解绑播放器。
   * @param el 传入元素时，**仅当它正是当前绑定的元素**才解绑；
   *   这样路由切换（LivePage 卸载 ↔ ReviewPage 挂载）时不会误清新页面刚绑定的元素。
   */
  detachPlayer(el?: HTMLAudioElement | null): void {
    if (el && this.player !== el) return;
    if (this.player) this.player.pause();
    this.player = null;
  }

  /** 载入音频（null 表示卸载） */
  loadAudio(blob: Blob | null): void {
    this.releaseUrl();
    this.pendingSeekSec = null;
    this.audioBlob = blob;
    if (!blob) {
      if (this.player) {
        this.player.pause();
        this.player.removeAttribute('src');
        this.player.load();
      }
      return;
    }
    this.ensurePlayer();
    this.playerUrl = URL.createObjectURL(blob);
    if (this.player) {
      this.player.src = this.playerUrl;
      this.player.load();
    }
  }

  /**
   * 是否已有可播放的音源。
   *
   * ★ **仅适用于「同会话的会中实时页」**：判定依据是进程内存态
   *   （`audioBlob` 或录音分片 `chunks`）。`destroy()`（结束会议时调用）会把两者
   *   清空并 revoke objectURL，因此**跨会话场景（纪要页 / 历史页）恒为 false**。
   *   判断「这场会是否有录音记录」请一律用持久化字段 `meeting.hasAudio`，
   *   音频内容走 `Repository.getAudio(meetingId)` —— 否则会把有录音的历史会议的播放器藏掉。
   */
  hasAudioSource(): boolean {
    return this.audioBlob !== null || this.chunks.length > 0;
  }

  /** 跳到相对毫秒（录音时间轴 == 会议时间轴，无需换算） */
  seekToRelMs(ms: number): void {
    const el = this.player ?? this.ensurePlayer();
    if (!el) return;
    const sec = Math.max(0, Math.floor(ms) / 1000);
    try {
      el.currentTime = sec;
      this.pendingSeekSec = null;
    } catch {
      // 元数据未就绪：挂起到 loadedmetadata 再跳
      this.pendingSeekSec = sec;
    }
  }

  play(): void {
    const el = this.player ?? this.ensurePlayer();
    if (!el) return;
    void el.play().catch(() => undefined);
  }

  pause(): void {
    const el = this.player;
    if (!el) return;
    el.pause();
  }

  /**
   * 从相对毫秒处开始播放。
   * 会中无成品音频时，用已收集的分片临时合成 Blob 供回听（尽力而为）。
   * @returns 是否成功起播
   */
  async playFrom(relMs: number): Promise<boolean> {
    const el = this.player ?? this.ensurePlayer();
    if (!el) return false;
    if (!this.audioBlob) {
      if (this.chunks.length === 0) return false;
      this.loadAudio(new Blob(this.chunks, { type: this.recMime }));
    }
    this.seekToRelMs(relMs);
    await new Promise<void>((r) => window.setTimeout(r, 30));
    try {
      await el.play();
      return true;
    } catch {
      return false;
    }
  }

  /* ==================== 生命周期 ==================== */

  /** 释放麦克风、分析链路与播放器 */
  destroy(): void {
    this.stopLoop();
    if (this.energyTimer !== null) {
      window.clearInterval(this.energyTimer);
      this.energyTimer = null;
    }
    this.spikeCbs.clear();
    if (this.recorder && this.recState === 'recording') {
      try {
        this.recorder.stop();
      } catch {
        /* 忽略 */
      }
    }
    this.recorder = null;
    this.recState = 'idle';
    this.chunks = [];
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        /* 忽略 */
      }
      this.sourceNode = null;
    }
    this.analyser = null;
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
    this.releaseUrl();
    this.audioBlob = null;
    if (this.ownedPlayer) {
      this.ownedPlayer.pause();
      this.ownedPlayer.removeAttribute('src');
      if (this.ownedPlayer.parentElement) this.ownedPlayer.parentElement.removeChild(this.ownedPlayer);
      this.ownedPlayer = null;
    }
    this.player = null;
    this.levelValue = 0;
  }

  /* ==================== 内部实现 ==================== */

  /** 建立 AnalyserNode 链路 */
  private setupAnalyser(stream: MediaStream): void {
    this.disposeAnalyser();
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      const ctx = new Ctor();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      const src = ctx.createMediaStreamSource(stream);
      src.connect(analyser);
      this.audioCtx = ctx;
      this.analyser = analyser;
      this.sourceNode = src;
      this.timeData = new Uint8Array(analyser.fftSize);
      void ctx.resume().catch(() => undefined);
    } catch {
      this.audioCtx = null;
      this.analyser = null;
      this.sourceNode = null;
    }
  }

  /** 切设备后重建源节点（analyser 与 recorder 均不受影响） */
  private rebindSource(stream: MediaStream): void {
    const ctx = this.audioCtx;
    const analyser = this.analyser;
    if (!ctx || !analyser) {
      this.setupAnalyser(stream);
      return;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        /* 忽略 */
      }
      this.sourceNode = null;
    }
    try {
      const src = ctx.createMediaStreamSource(stream);
      src.connect(analyser);
      this.sourceNode = src;
    } catch {
      this.sourceNode = null;
    }
    // 设备切换后重建 source 节点，需把 ASR 的 PCM 抽取链路也接回新 source。
    if (this.pcmTap) this.connectPcmTap();
  }

  private disposeAnalyser(): void {
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        /* 忽略 */
      }
      this.sourceNode = null;
    }
    this.analyser = null;
  }

  /** rAF 采样循环：更新电平并收集能量样本 */
  private startLoop(): void {
    if (this.rafId !== null) return;
    const tick = (): void => {
      const a = this.analyser;
      if (!a || !this.timeData.length) {
        this.rafId = null;
        return;
      }
      a.getByteTimeDomainData(this.timeData);
      let sum = 0;
      for (let i = 0; i < this.timeData.length; i += 1) {
        const v = (this.timeData[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / this.timeData.length);
      this.levelValue = Math.min(1, rms * LEVEL_GAIN);
      this.windowSamples.push(rms);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /** 每 500ms 判定一次能量突变 */
  private startEnergyTimer(): void {
    if (this.energyTimer !== null) return;
    this.energyTimer = window.setInterval(() => {
      const samples = this.windowSamples;
      this.windowSamples = [];
      if (samples.length === 0) return;
      let sum = 0;
      for (const s of samples) sum += s;
      const avg = sum / samples.length;
      const prev = this.prevWindowAvg;
      this.prevWindowAvg = avg;
      if (prev < ENERGY_MIN_RMS || avg < ENERGY_MIN_RMS) return;
      const delta = avg / prev;
      if (delta < ENERGY_RATIO) return;
      const evt: EnergySpike = { atMs: this.recMs(), delta, suggestionId: null };
      for (const cb of Array.from(this.spikeCbs)) {
        try {
          cb(evt);
        } catch {
          /* 单个回调出错不影响其他订阅者 */
        }
      }
    }, ENERGY_WINDOW_MS);
  }

  /** 累计录音时长并停表 */
  private accumulateRec(): void {
    if (this.recTickAt !== null) {
      this.recElapsedMs += Date.now() - this.recTickAt;
      this.recTickAt = null;
    }
  }

  /** 合成 Blob 并 resolve stopRec */
  private finishStop(): void {
    const resolver = this.stopResolver;
    if (!resolver) return;
    this.stopResolver = null;
    this.recState = 'stopped';
    this.recorder = null;
    const blob = this.chunks.length > 0 ? new Blob(this.chunks, { type: this.recMime }) : null;
    this.chunks = [];
    resolver(blob ? { blob, size: blob.size, mime: this.recMime } : null);
  }

  /** 释放 objectURL */
  private releaseUrl(): void {
    if (this.playerUrl) {
      URL.revokeObjectURL(this.playerUrl);
      this.playerUrl = null;
    }
  }
}

/** 全局单例 */
export const mediaController: MediaController = new MediaController();

export { MediaController };
