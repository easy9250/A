/**
 * 速记会话 Hook —— 把「语音引擎 + 麦克风录音 + 状态仓库 + 结构化整合」缝到一起。
 *
 * 对外暴露：boot / finish / pushNote / readLevel / booting / level / label。
 *
 * 关键约束：
 * 1) interim 不进 entries，以 200ms 节流写 store；final 到达立即清 interim；
 * 2) 任何语音降级都 setLevel + setBanner（永不静默失败）；
 * 3) 结束会话：停识别 → 停录音 → 取 Blob → structureMeeting → buildSnapshot
 *    → computeSessionStats → 落盘（saveSnapshot + putAudio）→ loadResult。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LangCode, SpeechLevel, UtteranceSource } from '@/types/models';
import { mediaController, type AudioDeviceOption } from '@/core/audio/MediaController';
import { createSpeechProvider, ManualProvider, type ISpeechProvider, type SpeechEventHandlers } from '@/core/speech';
import { structureMeeting, type StructResult } from '@/core/struct';
import { getRepo } from '@/core/repo';
import { toast, useUiStore } from '@/stores/useUiStore';
import { getTencentAsrConfig } from '@/services/asrConfig';
import { isTauri } from '@/lib/platform';
import { throttle } from '@/lib/utils';
import { useQuickSessionStore } from './store';
import { buildSnapshot, mergeEntriesToUtterances, sessionMeeting } from './integrate';
import { computeSessionStats } from './stats';
import type { QuickSessionResult } from './types';

/** 空结构化结果（兜底，正常路径下 structureMeeting 不会返回空） */
const EMPTY_STRUCT: StructResult = { topics: [], decisions: [], actionItems: [], origin: 'rule' };

export interface QuickSessionApi {
  /** 正在启动（探活中） */
  booting: boolean;
  /** 当前识别级别 */
  level: SpeechLevel;
  /** 当前模式徽标文案 */
  label: string;
  /** 启动：取麦克风 → 探活 → 起识别 */
  boot: () => Promise<void>;
  /** 结束会话：整合 + 落盘 + 生成结果 */
  finish: () => Promise<void>;
  /** 新增一条文字笔记（相对会话开始毫秒自动计算） */
  pushNote: (text: string) => void;
  /** 当前音量电平（0..1），供音量条轮询 */
  readLevel: () => number;
  /** 是否正在试音（已拿到麦克风，仅监听电平，未开始录音） */
  testing: boolean;
  /** 试音失败的错误信息（权限 / 设备 / 上下文） */
  levelError: string | null;
  /** 可用麦克风设备列表 */
  devices: AudioDeviceOption[];
  /** 当前使用的设备 ID */
  deviceId: string;
  /** 开始试音：申请麦克风并监听电平 */
  testMic: () => Promise<void>;
  /** 停止试音并释放麦克风 */
  stopTest: () => void;
  /** 切换输入设备（试音或记录中均可调用） */
  switchDevice: (id: string) => Promise<void>;
}

/**
 * 速记会话。一个页面实例只应调用一次 boot()（内部有幂等守卫）。
 */
export function useQuickSession(): QuickSessionApi {
  const [booting, setBooting] = useState<boolean>(false);
  const [level, setLevel] = useState<SpeechLevel>(0);
  const [label, setLabel] = useState<string>('未开始');

  /* ---------------- 试音 / 设备选择 ---------------- */
  const [testing, setTesting] = useState<boolean>(false);
  const [levelError, setLevelError] = useState<string | null>(null);
  const [devices, setDevices] = useState<AudioDeviceOption[]>([]);
  const [deviceId, setDeviceIdState] = useState<string>('');

  const providerRef = useRef<ISpeechProvider | null>(null);
  const bootedRef = useRef<boolean>(false);

  /* ---------------- interim 200ms 节流写入（不进 entries） ---------------- */
  const applyInterim = useMemo(
    () =>
      throttle((text: string) => {
        useQuickSessionStore.getState().setInterim(text);
      }, 200),
    [],
  );

  /* ---------------- 事件回调 ---------------- */
  const handlers = useMemo<SpeechEventHandlers>(
    () => ({
      onInterim: (text: string) => {
        applyInterim(text);
      },
      onFinal: (text: string, _atMs: number, _confidence?: number, source?: UtteranceSource) => {
        applyInterim.cancel();
        useQuickSessionStore.getState().setInterim('');
        const st = useQuickSessionStore.getState();
        if (!st.startedAt) return;
        const rel = Date.now() - st.startedAt;
        st.addVoice(text, rel, source === 'manual' ? 'manual' : 'asr');
      },
      onNotice: (msg: string) => {
        if (msg) toast.info(msg);
      },
      onLevelChange: (nextLevel: SpeechLevel, reason: string) => {
        setLevel(nextLevel);
        useQuickSessionStore.getState().setLevel(nextLevel);
        useQuickSessionStore
          .getState()
          .setBanner(reason ? { msg: reason, kind: nextLevel === 0 ? 'info' : 'warning' } : null);
      },
      onAutoRestart: (times: number) => {
        if (times === 1) toast.info('识别连接已自动恢复，文本未丢失');
      },
    }),
    [applyInterim],
  );

  const handlersRef = useRef<SpeechEventHandlers>(handlers);
  handlersRef.current = handlers;

  /* ---------------- 启动 ---------------- */
  const boot = useCallback(async (): Promise<void> => {
    const st = useQuickSessionStore.getState();
    if (bootedRef.current || !st.meetingId) return;
    bootedRef.current = true;
    setBooting(true);
    useQuickSessionStore.getState().setLevel(0, '正在探测识别能力…');

    let micOk = true;
    let stream: MediaStream | null = null;
    let bootErr: unknown = null;
    try {
      const preferred = useUiStore.getState().deviceId || undefined;
      if (!mediaController.stream) {
        // 试音阶段可能已拿过麦克风：直接复用，避免重复弹权限框
        stream = await mediaController.init(preferred);
      } else if (preferred && preferred !== mediaController.getDeviceId()) {
        await mediaController.switchDevice(preferred);
        stream = mediaController.stream;
      } else {
        stream = mediaController.stream;
      }
      mediaController.startRec();
      setTesting(false);
      // 填充设备列表，供记录中切换输入设备
      const devs = await mediaController.listDevices();
      setDevices(devs);
      setDeviceIdState(mediaController.getDeviceId());
    } catch (e) {
      micOk = false;
      stream = null;
      bootErr = e; // 根因留待 createSpeechProvider 降级后，覆写为可读提示
    }

    try {
      const provider = await createSpeechProvider(handlersRef.current, {
        lang: st.lang,
        probeMs: 8000,
        micOk,
        asrConfig: getTencentAsrConfig(),
      });
      providerRef.current = provider;
      setLevel(provider.level);
      setLabel(provider.label);
      useQuickSessionStore.getState().setLevel(provider.level, provider.label);
      await provider.start(stream);
    } catch {
      const fallback = new ManualProvider(handlersRef.current);
      providerRef.current = fallback;
      setLevel(2);
      setLabel(fallback.label);
      useQuickSessionStore.getState().setLevel(2, fallback.label);
      useQuickSessionStore.getState().setBanner({
        msg: '识别能力初始化失败，已切换为本地手动模式，你仍可记录文字笔记',
        kind: 'warning',
      });
      await fallback.start(stream);
    }

    /* 麦克风初始化失败时，用精确根因覆盖 createSpeechProvider 的笼统降级文案 */
    if (bootErr) {
      const inIframe = typeof window !== 'undefined' && window.self !== window.top;
      const code = (bootErr as { code?: string })?.code;
      let msg = '麦克风不可用，已切换为本地手动模式，你仍可记录文字笔记';
      if (isTauri()) {
        // 原生壳内：WebView 即主文档（非 iframe），且 tauri://localhost 为安全上下文，
        // 因此 iframe / INSECURE_CONTEXT 分支不会触发；只需按权限/设备给出原生友好提示。
        if (code === 'MIC_DENIED') {
          msg = '麦克风权限被拒绝。请在系统「设置 → 隐私 → 麦克风」中允许本应用使用麦克风后重试。';
        } else if (code === 'MIC_NOT_FOUND') {
          msg = '未检测到可用的音频输入设备，或所选设备当前不可用。请在「麦克风测试」里重新选择设备，或检查系统麦克风。';
        } else {
          msg = '无法访问麦克风，已切换为本地手动模式，你仍可记录文字笔记。请在系统设置中检查麦克风权限。';
        }
      } else if (inIframe) {
        msg = '当前内置预览环境（沙箱）未授权麦克风，无法录音/转写。请在系统浏览器（Chrome / Edge）新标签页打开本地址，并允许麦克风权限后重试。';
      } else if (code === 'INSECURE_CONTEXT') {
        msg = '当前访问地址不是「安全上下文」，浏览器禁止用麦克风。请改用 http://localhost:5173/ 访问（不要用 192.168.x.x 这类局域网地址），或部署到 HTTPS。';
      } else if (code === 'MIC_DENIED') {
        msg = '麦克风权限被拒绝。请点击地址栏左侧的站点图标 → 允许麦克风 → 刷新页面重试。';
      } else if (code === 'MIC_NOT_FOUND') {
        msg = '未检测到可用的音频输入设备，或所选输入设备当前不可用。请在「麦克风测试」里重新选择设备，或检查系统麦克风。';
      }
      useQuickSessionStore.getState().setBanner({ msg, kind: 'warning' });
    }

    setBooting(false);
  }, []);

  /* ---------------- 新增笔记 ---------------- */
  const pushNote = useCallback((text: string) => {
    const st = useQuickSessionStore.getState();
    if (!st.startedAt) return;
    const rel = Date.now() - st.startedAt;
    st.addNote(text, rel);
  }, []);

  /* ---------------- 试音：申请麦克风并监听电平（不开始录音） ---------------- */
  const testMic = useCallback(async (): Promise<void> => {
    setLevelError(null);
    try {
      await mediaController.init();
      const devs = await mediaController.listDevices();
      setDevices(devs);
      setDeviceIdState(mediaController.getDeviceId());
      setTesting(true);
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === 'MIC_DENIED') {
        setLevelError(
          isTauri()
            ? '麦克风权限被拒绝，请在系统「设置 → 隐私 → 麦克风」中允许本应用后重试'
            : '麦克风权限被拒绝，请在浏览器地址栏的站点设置中允许麦克风后重试',
        );
      } else if (code === 'INSECURE_CONTEXT') {
        setLevelError('当前不是安全上下文（需 HTTPS 或 localhost），无法访问麦克风');
      } else {
        setLevelError('无法访问麦克风：' + ((e as Error)?.message ?? '未知错误'));
      }
    }
  }, []);

  /* ---------------- 停止试音并释放麦克风 ---------------- */
  const stopTest = useCallback((): void => {
    mediaController.destroy();
    setTesting(false);
  }, []);

  /* ---------------- 切换输入设备（试音 / 记录中均可） ---------------- */
  const switchDevice = useCallback(async (id: string): Promise<void> => {
    if (!id) return;
    try {
      await mediaController.switchDevice(id);
      setDeviceIdState(id);
      useUiStore.getState().setDeviceId(id);
    } catch {
      setLevelError('切换输入设备失败，请重试');
    }
  }, []);

  /* ---------------- 结束会话：整合 + 落盘 ---------------- */
  const finish = useCallback(async (): Promise<void> => {
    const st = useQuickSessionStore.getState();
    if (!st.meetingId || !st.startedAt) return;

    applyInterim.cancel();
    st.setInterim('');
    providerRef.current?.stop();

    // 1) 停止录音并取 Blob
    let rec: { blob: Blob; size: number; mime: string } | null = null;
    try {
      rec = await mediaController.stopRec();
    } catch {
      rec = null;
    }
    const endedAt = Date.now();
    const hasAudio = Boolean(rec && rec.size > 0);

    // 2) 先存音频（若有的话），拿到 audioLocalKey
    let audioLocalKey: string | undefined;
    if (rec && rec.size > 0) {
      try {
        audioLocalKey = (await getRepo().putAudio(st.meetingId, rec.blob)) ?? undefined;
      } catch {
        audioLocalKey = undefined;
      }
    }

    // 3) 组装结构化输入并整合笔记 + 语音
    const utterances = mergeEntriesToUtterances(st.meetingId, st.entries);
    const meeting = sessionMeeting({
      meetingId: st.meetingId,
      title: st.title,
      startedAt: st.startedAt,
      endedAt,
      lang: st.lang,
      hasAudio,
      audioLocalKey,
    });

    let struct: StructResult = EMPTY_STRUCT;
    try {
      struct = await structureMeeting({ meeting, participants: [], utterances });
    } catch {
      struct = EMPTY_STRUCT;
    }

    // 4) 产出快照与统计
    const snapshot = buildSnapshot({
      meetingId: st.meetingId,
      title: st.title,
      startedAt: st.startedAt,
      endedAt,
      lang: st.lang,
      hasAudio,
      audioLocalKey,
      entries: st.entries,
      struct,
    });
    const stats = computeSessionStats({
      startedAt: st.startedAt,
      endedAt,
      entries: st.entries,
      struct,
      hasAudio,
    });

    // 5) 落盘（最佳实践：先快照后音频已处理；此处再补一次 saveSnapshot）
    try {
      await getRepo().saveSnapshot(snapshot);
    } catch {
      toast.warning('本地保存失败，但你可以直接导出结果');
    }

    // 6) 释放麦克风，置结果
    mediaController.destroy();
    providerRef.current?.destroy();
    providerRef.current = null;
    bootedRef.current = false;

    const result: QuickSessionResult = { snapshot, stats, hasAudio };
    st.loadResult(result);
  }, []);

  /* ---------------- 卸载：只清 interim 节流，不动录音（允许页面短暂切换） ---------------- */
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
    boot,
    finish,
    pushNote,
    readLevel: () => mediaController.getLevel(),
    testing,
    levelError,
    devices,
    deviceId,
    testMic,
    stopTest,
    switchDevice,
  };
}

export default useQuickSession;
