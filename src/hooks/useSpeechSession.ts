/**
 * 语音会话 Hook —— 把「Provider + MediaController + 两个 store」缝到一起。
 *
 * 对外暴露：boot / pause / resume / finish / pushManualText / switchDevice / seekPlay。
 *
 * 关键约束实现：
 * 1) interim **绝不进 uttMap**：以 200ms 节流写 `useUiStore.setInterim`；
 * 2) final 的 `startMs` 取会议时钟 `elapsedMs()`（§7.2：录音时间轴 == 会议时间轴）；
 * 3) 任何降级都 `setSpeechLevel` + `setBanner`（永不静默失败）；
 * 4) 结束会议：stopRec → endMeeting → putAudio → 立即落盘。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LangCode, SpeechLevel, UtteranceSource } from '@/types/models';
import { mediaController, type AudioDeviceOption } from '@/core/audio/MediaController';
import { createSpeechProvider, type ISpeechProvider, type SpeechEventHandlers } from '@/core/speech';
import { ManualProvider, RecordOnlyProvider } from '@/core/speech/FallbackProviders';
import { useMeetingStore } from '@/stores/useMeetingStore';
import { toast, useUiStore } from '@/stores/useUiStore';
import { getTencentAsrConfig } from '@/services/asrConfig';
import { errText, getRepo } from '@/core/repo';
import { throttle } from '@/lib/utils';

/** 会话对外 API */
export interface SpeechSessionApi {
  /** 正在启动（探活中） */
  booting: boolean;
  /** 当前识别级别 */
  level: SpeechLevel;
  /** 当前模式徽标文案 */
  label: string;
  /** 音频输入设备列表 */
  devices: AudioDeviceOption[];
  /** 启动会话：先取麦克风 → 再探活 → 起识别 */
  boot: (opts: { meetingId: string; lang: LangCode }) => Promise<void>;
  /** 暂停：识别停 + 录音停 + 会议停（三者成对） */
  pause: () => void;
  /** 继续 */
  resume: () => void;
  /** 结束会议并落盘，返回 meetingId */
  finish: () => Promise<string | null>;
  /** 手动补录一条文本（L2 主路径 / L1 粘贴外部转录） */
  pushManualText: (text: string, atMs?: number) => void;
  /** 切换麦克风（不中断录音） */
  switchDevice: (deviceId: string) => Promise<void>;
  /** 刷新设备列表 */
  refreshDevices: () => Promise<void>;
  /** 跳到相对毫秒播放 */
  seekPlay: (ms: number) => Promise<boolean>;
  /** 当前音量电平（0..1）读取器（供音量条轮询） */
  readLevel: () => number;
}

/**
 * 当前会话的「结束器」（模块级，由 boot 注册）。
 *
 * ★ 为什么需要它：LivePage 卸载（用户切到历史页 / 纪要页）时我们**故意不停麦**，
 *   识别 Provider 仍在后台写发言；此时若要结束会议，只能拿到 LivePage 那个 hook
 *   实例里的 `finish()`（它持有真正的 providerRef）。这里保存的闭包让
 *   AppHeader 这类全局组件也能正确停掉识别 + 停录音 + 存音频 + 落盘。
 */
let activeFinisher: (() => Promise<string | null>) | null = null;

/**
 * 结束当前进行中的会议（供非 LivePage 组件调用，如 AppHeader 全局提示条）。
 *
 * - 已 boot 过：走会话的完整 finish（停识别 → 停录音 → putAudio → endMeeting → 落盘）；
 * - 未 boot（例如刷新后直接停在非实时页）：兜底冻结会议并落盘，保证不丢字幕。
 * @returns meetingId；无进行中的会议返回 null
 */
export async function finishActiveSession(): Promise<string | null> {
  if (activeFinisher) return activeFinisher();
  const st = useMeetingStore.getState();
  if (!st.meeting) return null;
  const meetingId = st.meeting.id;
  st.endMeeting({ hasAudio: st.meeting.hasAudio, durationMs: st.elapsedMs() });
  const snap = useMeetingStore.getState().getSnapshot();
  if (snap) {
    try {
      await getRepo().saveSnapshot(snap);
      useMeetingStore.getState().markSaved();
    } catch {
      toast.error('保存失败，请及时导出备份');
    }
  }
  return meetingId;
}

/**
 * 语音会话。一个页面实例只应调用一次 `boot()`（内部有幂等守卫）。
 */
export function useSpeechSession(): SpeechSessionApi {
  const [booting, setBooting] = useState<boolean>(false);
  const [level, setLevel] = useState<SpeechLevel>(0);
  const [label, setLabel] = useState<string>('未开始');
  const [devices, setDevices] = useState<AudioDeviceOption[]>([]);

  const providerRef = useRef<ISpeechProvider | null>(null);
  const bootedRef = useRef<boolean>(false);
  const levelRef = useRef<SpeechLevel>(0);
  const lastUttIdRef = useRef<string | null>(null);
  /** 始终指向最新的 finish 闭包（LivePage 卸载后仍可被全局结束器调用） */
  const finishRef = useRef<(() => Promise<string | null>) | null>(null);

  /* ---------------- interim 200ms 节流写入（不进 uttMap） ---------------- */
  const applyInterim = useMemo(
    () =>
      throttle((text: string, atMs: number) => {
        useUiStore.getState().setInterim(text, atMs);
      }, 200),
    [],
  );

  /* ---------------- 事件回调 ---------------- */
  const handlers = useMemo<SpeechEventHandlers>(
    () => ({
      onInterim: (text: string, atMs: number) => {
        applyInterim(text, atMs);
      },
      onFinal: (text: string, atMs: number, confidence?: number, source?: UtteranceSource) => {
        // final 到达：立刻清掉 interim，避免同一句话重复显示
        applyInterim.cancel();
        useUiStore.getState().setInterim('', 0);

        const st = useMeetingStore.getState();
        if (!st.meeting) return;
        // ★ 时间轴：优先用会议累计活动时钟（录音时间轴 == 会议时间轴）
        const relMs = st.meeting ? st.elapsedMs() : atMs;
        // 上一条发言的 endMs 收敛到本条起点
        const lastId = lastUttIdRef.current;
        if (lastId) st.updateUtterance(lastId, { endMs: relMs });
        const utt = st.addUtterance({
          text,
          startMs: relMs,
          endMs: relMs,
          source: source ?? 'asr',
          confidence,
          isFinal: true,
        });
        if (utt) lastUttIdRef.current = utt.id;
      },
      onNotice: (msg: string) => {
        if (!msg) return;
        toast.info(msg);
      },
      onLevelChange: (nextLevel: SpeechLevel, reason: string) => {
        setLevel(nextLevel);
        const ui = useUiStore.getState();
        ui.setSpeechLevel(nextLevel);
        ui.setBanner(reason ? reason : null, nextLevel === 0 ? 'info' : 'warning');
        // 级别真的变了：换 Provider（不再重新探活，直接构造对应实现）
        if (nextLevel !== levelRef.current) {
          levelRef.current = nextLevel;
          const old = providerRef.current;
          old?.destroy();
          const next: ISpeechProvider = nextLevel === 2 ? new ManualProvider(handlers) : new RecordOnlyProvider(handlers);
          providerRef.current = next;
          setLabel(next.label);
          void next.start(mediaController.stream).catch(() => undefined);
        }
      },
      onAutoRestart: (times: number) => {
        // 只在第一次重连时提示，避免频繁打扰
        if (times === 1) toast.info('识别连接已自动恢复，文本未丢失');
      },
    }),
    [applyInterim],
  );

  /** 回调集合放进 ref，避免 provider 持有过期闭包 */
  const handlersRef = useRef<SpeechEventHandlers>(handlers);
  handlersRef.current = handlers;

  /* ---------------- 设备列表 ---------------- */
  const refreshDevices = useCallback(async () => {
    const list = await mediaController.listDevices();
    setDevices(list);
  }, []);

  /* ---------------- 启动 ---------------- */
  const boot = useCallback(
    async (opts: { meetingId: string; lang: LangCode }) => {
      if (bootedRef.current) return;
      bootedRef.current = true;
      // 注册全局结束器：即使 LivePage 之后被卸载，也能正确停麦 / 存音频 / 落盘
      activeFinisher = () => (finishRef.current ? finishRef.current() : Promise.resolve(null));
      setBooting(true);
      useUiStore.getState().setSpeechLevel(0, '正在探测识别能力…');

      let micOk = true;
      let stream: MediaStream | null = null;
      try {
        const preferred = useUiStore.getState().deviceId || undefined;
        stream = await mediaController.init(preferred);
        mediaController.startRec();
      } catch (e) {
        micOk = false;
        stream = null;
        toast.error(errText(e));
      }

      try {
        const provider = await createSpeechProvider(handlersRef.current, {
          lang: opts.lang,
          probeMs: 8000,
          micOk,
          asrConfig: getTencentAsrConfig(),
        });
        providerRef.current = provider;
        levelRef.current = provider.level;
        setLevel(provider.level);
        setLabel(provider.label);
        await provider.start(stream);
      } catch {
        // 兜底：构造失败时退到 L2，绝不静默失败
        const fallback = new ManualProvider(handlersRef.current);
        providerRef.current = fallback;
        levelRef.current = 2;
        setLevel(2);
        setLabel(fallback.label);
        useUiStore.getState().setSpeechLevel(2);
        useUiStore.getState().setBanner('识别能力初始化失败，已切换为本地手动模式', 'warning');
        await fallback.start(stream);
      }

      void refreshDevices();
      setBooting(false);
    },
    [refreshDevices],
  );

  /* ---------------- 暂停 / 继续 ---------------- */
  const pause = useCallback(() => {
    providerRef.current?.pause();
    mediaController.pauseRec();
    useMeetingStore.getState().pauseMeeting();
    applyInterim.cancel();
    useUiStore.getState().setInterim('', 0);
  }, [applyInterim]);

  const resume = useCallback(() => {
    useMeetingStore.getState().resumeMeeting();
    mediaController.resumeRec();
    providerRef.current?.resume();
  }, []);

  /* ---------------- 手动补录 ---------------- */
  const pushManualText = useCallback((text: string, atMs?: number) => {
    const clean = String(text ?? '').trim();
    if (!clean) return;
    const st = useMeetingStore.getState();
    const rel = atMs ?? (st.meeting ? st.elapsedMs() : 0);
    const provider = providerRef.current;
    if (!provider) {
      // 会话尚未就绪：也保证文本不丢
      const lastId2 = lastUttIdRef.current;
      if (lastId2) st.updateUtterance(lastId2, { endMs: rel });
      const u = st.addUtterance({ text: clean, startMs: rel, endMs: rel, source: 'manual' });
      if (u) lastUttIdRef.current = u.id;
      return;
    }
    provider.pushManualText(clean, rel);
  }, []);

  /* ---------------- 切设备 ---------------- */
  const switchDevice = useCallback(async (deviceId: string) => {
    try {
      await mediaController.switchDevice(deviceId);
      useUiStore.getState().setDeviceId(deviceId);
      toast.success('已切换麦克风，录音未中断');
    } catch (e) {
      toast.error(errText(e));
    }
  }, []);

  /* ---------------- 时间码跳转播放 ---------------- */
  const seekPlay = useCallback(async (ms: number) => {
    const ok = await mediaController.playFrom(ms);
    if (!ok) toast.info('暂无可播放的录音，会议结束后可在纪要页跳转到此处回听');
    return ok;
  }, []);

  /* ---------------- 音量读取 ---------------- */
  const readLevel = useCallback(() => mediaController.getLevel(), []);

  /* ---------------- 结束会议 ---------------- */
  const finish = useCallback(async (): Promise<string | null> => {
    const st = useMeetingStore.getState();
    const meeting = st.meeting;
    if (!meeting) return null;
    const meetingId = meeting.id;

    // 1) 停识别
    applyInterim.cancel();
    useUiStore.getState().setInterim('', 0);
    providerRef.current?.stop();

    // 2) 停录音并取 Blob
    let rec: { blob: Blob; size: number; mime: string } | null = null;
    try {
      rec = await mediaController.stopRec();
    } catch {
      rec = null;
    }

    // 3) 冻结会议（durationMs = 累计活动时长）
    const durationMs = useMeetingStore.getState().elapsedMs();
    useMeetingStore.getState().endMeeting({ hasAudio: Boolean(rec && rec.size > 0), durationMs });

    // 4) 存音频 → 回填 audioLocalKey
    if (rec && rec.size > 0) {
      const key = await getRepo().putAudio(meetingId, rec.blob);
      if (key) {
        useMeetingStore.getState().patchMeeting({ audioLocalKey: key, hasAudio: true });
      }
    }

    // 5) 立即落盘
    const snap = useMeetingStore.getState().getSnapshot();
    if (snap) {
      try {
        await getRepo().saveSnapshot(snap);
        useMeetingStore.getState().markSaved();
      } catch {
        toast.error('保存失败，请及时导出备份');
      }
    }

    // 6) 释放麦克风（播放器由 ReviewPage 重新挂载）
    mediaController.destroy();
    providerRef.current?.destroy();
    providerRef.current = null;
    bootedRef.current = false;
    activeFinisher = null;
    return meetingId;
  }, [applyInterim]);

  // 让模块级结束器始终拿到最新闭包（含最新的 providerRef）
  finishRef.current = finish;

  /* ---------------- 卸载：只释放识别，不动录音（允许中途跳转后再回来） ---------------- */
  useEffect(
    () => () => {
      applyInterim.cancel();
    },
    [applyInterim],
  );

  return {
    booting,
    level,
    label,
    devices,
    boot,
    pause,
    resume,
    finish,
    pushManualText,
    switchDevice,
    refreshDevices,
    seekPlay,
    readLevel,
  };
}

export default useSpeechSession;
