/**
 * 实时会议页（页面 A）。
 *
 * 组成：`LiveTopBar` + `SpeakerBar` + `TranscriptList`（L2 时主区上半切换为手动输入大文本框）
 * + `LiveBottomBar`。
 *
 * 关键约定：
 * - 路由 `/live/new` 表示新建会议；`/live/:id` 表示恢复已有会议（从 IndexedDB 读取）；
 * - 快捷键只**监听** App.tsx 广播的语义事件（`mm:toggle-pause` / `mm:select-speaker` / `mm:star` /
 *   `mm:escape`），绝不重复注册 window 监听；Ctrl/Cmd+Z 与 Ctrl/Cmd+S 已由 App 处理；
 * - 结束会议必须走 `requestConfirm` 二次确认，结束后跳转 `/review/:id` 交给 T05。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { LiveBottomBar, LiveTopBar } from '@/components/live/LiveBars';
import { SpeakerBar } from '@/components/live/SpeakerBar';
import { TranscriptList } from '@/components/live/TranscriptList';
import { useSpeechSession } from '@/hooks/useSpeechSession';
import { useEnergyHint } from '@/hooks/useEnergyHint';
import { mediaController } from '@/core/audio/MediaController';
import { getRepo } from '@/core/repo';
import { useMeetingStore } from '@/stores/useMeetingStore';
import { toast, useUiStore } from '@/stores/useUiStore';
import { MAX_PARTICIPANTS, UNKNOWN_SPEAKER_ID, type Participant } from '@/types/models';

/** 时钟刷新间隔（触发 store.tick()） */
const TICK_MS = 500;

/**
 * L2 / 手动补录面板：大文本框 + 粘贴外部转录批量导入。
 */
function ManualPane(props: { onSubmit: (text: string) => void; onBatch: (text: string) => void }): JSX.Element {
  const [text, setText] = useState<string>('');

  const submit = useCallback(() => {
    const v = text.trim();
    if (!v) return;
    // 含换行 → 视为批量粘贴的外部转录
    if (v.includes('\n')) props.onBatch(v);
    else props.onSubmit(v);
    setText('');
  }, [props, text]);

  return (
    <Paper variant="outlined" sx={{ p: 1.5, mb: 1 }}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        手动录入发言
      </Typography>
      <Typography variant="caption" color="text.secondary">
        单行回车 = 补录 1 条；多行粘贴 = 按行批量导入外部转录（Ctrl/Cmd + Enter 提交）
      </Typography>
      <TextField
        multiline
        fullWidth
        minRows={4}
        maxRows={12}
        value={text}
        placeholder="在此输入发言内容，或从其他转录工具整段粘贴…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submit();
          }
        }}
        sx={{ mt: 1 }}
      />
      <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
        <Button size="small" variant="contained" disabled={!text.trim()} onClick={submit}>
          添加到字幕流
        </Button>
        <Button size="small" color="inherit" disabled={!text.trim()} onClick={() => setText('')}>
          清空
        </Button>
      </Stack>
    </Paper>
  );
}

/**
 * 实时会议页。
 */
export default function LivePage(): JSX.Element {
  const { id = 'new' } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const session = useSpeechSession();
  const { boot, pause, resume, finish, pushManualText, switchDevice, seekPlay, level, label, devices, booting } = session;

  const energyHintEnabled = useUiStore((s) => s.energyHintEnabled);
  const prefDeviceId = useUiStore((s) => s.deviceId);
  const autoFollow = useUiStore((s) => s.autoFollow);
  const setAutoFollow = useUiStore((s) => s.setAutoFollow);
  const requestConfirm = useUiStore((s) => s.requestConfirm);
  const { hint, dismiss } = useEnergyHint(energyHintEnabled);

  const meeting = useMeetingStore((s) => s.meeting);
  const participants = useMeetingStore((s) => s.participants);
  const utteranceCount = useMeetingStore((s) => s.utteranceIds.length);
  const markerCount = useMeetingStore((s) => s.markerIds.length);
  const currentSpeakerId = useMeetingStore((s) => s.currentSpeakerId);
  const dirty = useMeetingStore((s) => s.dirty);
  const saving = useMeetingStore((s) => s.saving);
  const lastSavedAt = useMeetingStore((s) => s.lastSavedAt);
  const clockVersion = useMeetingStore((s) => s.clockVersion);

  const [ending, setEnding] = useState<boolean>(false);
  const [manualOpen, setManualOpen] = useState<boolean>(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  /** 累计活动时长（随 clockVersion 变化重算） */
  const elapsedMs = clockVersion >= 0 ? useMeetingStore.getState().elapsedMs() : 0;
  /** 最近一条发言的相对毫秒（底栏展示） */
  const lastAtMs = useMeetingStore((s) => {
    const lastId = s.utteranceIds[s.utteranceIds.length - 1];
    return lastId ? s.uttMap[lastId]?.startMs ?? 0 : 0;
  });

  const realCount = useMemo(() => participants.filter((p) => p.id !== UNKNOWN_SPEAKER_ID).length, [participants]);

  /* ---------------- 绑定播放器（时间码跳转用） ---------------- */
  useEffect(() => {
    const el = audioRef.current;
    mediaController.attachPlayer(el);
    // 只解绑「自己绑定的那个」元素，避免路由切换时误清 ReviewPage 刚挂上的播放器
    return () => mediaController.detachPlayer(el);
  }, []);

  /* ---------------- 时钟：每 500ms tick 触发重渲染 ---------------- */
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (useMeetingStore.getState().meeting?.status === 'active') useMeetingStore.getState().tick();
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  /* ---------------- 装载会议：new → 新建；否则从本地库恢复 ---------------- */
  useEffect(() => {
    let alive = true;
    const prepare = async (): Promise<void> => {
      const st = useMeetingStore.getState();

      if (id === 'new') {
        if (!st.meeting || st.meeting.status === 'ended') {
          const m = st.startMeeting('', { lang: useUiStore.getState().lang, mode: 'web-speech' });
          navigate(`/live/${m.id}`, { replace: true });
          return; // 路由变化后本 effect 会以真实 id 重新执行
        }
        navigate(`/live/${st.meeting.id}`, { replace: true });
        return;
      }

      // 内存中已有这场会议（刚刚新建 / 从别处跳回）
      if (st.meeting?.id === id) {
        if (!alive) return;
        await boot({ meetingId: id, lang: st.meeting.lang });
        if (useMeetingStore.getState().meeting?.status === 'paused') pause();
        return;
      }

      const snap = await getRepo().loadSnapshot(id);
      if (!alive) return;
      if (!snap) {
        toast.error('未找到这场会议，已返回历史页');
        navigate('/', { replace: true });
        return;
      }
      useMeetingStore.getState().loadSnapshot(snap);
      const loaded = useMeetingStore.getState();
      if (loaded.meeting?.status === 'ended') {
        navigate(`/review/${id}`, { replace: true });
        return;
      }
      await boot({ meetingId: id, lang: loaded.meeting?.lang ?? useUiStore.getState().lang });
      if (useMeetingStore.getState().meeting?.status === 'paused') pause();
    };
    void prepare();
    return () => {
      alive = false;
    };
  }, [id, boot, navigate, pause]);

  /* ---------------- 快捷键：只监听 App 广播的语义事件 ---------------- */
  useEffect(() => {
    const onTogglePause = (): void => {
      const status = useMeetingStore.getState().meeting?.status;
      if (status === 'active') pause();
      else if (status === 'paused') resume();
    };
    const onSelectSpeaker = (e: Event): void => {
      const index = Number((e as CustomEvent<{ index: number }>).detail?.index ?? 0);
      if (!index) return;
      const list = useMeetingStore
        .getState()
        .participants.filter((p: Participant) => p.id !== UNKNOWN_SPEAKER_ID)
        .sort((a, b) => a.order - b.order);
      const target = list[index - 1];
      if (target) useMeetingStore.getState().setCurrentSpeaker(target.id);
    };
    const onStar = (): void => {
      const st = useMeetingStore.getState();
      const lastId = st.utteranceIds[st.utteranceIds.length - 1];
      if (!lastId) {
        toast.info('还没有发言可打点');
        return;
      }
      st.toggleStar(lastId);
    };
    const onEscape = (): void => setManualOpen(false);

    window.addEventListener('mm:toggle-pause', onTogglePause);
    window.addEventListener('mm:select-speaker', onSelectSpeaker);
    window.addEventListener('mm:star', onStar);
    window.addEventListener('mm:escape', onEscape);
    return () => {
      window.removeEventListener('mm:toggle-pause', onTogglePause);
      window.removeEventListener('mm:select-speaker', onSelectSpeaker);
      window.removeEventListener('mm:star', onStar);
      window.removeEventListener('mm:escape', onEscape);
    };
  }, [pause, resume]);

  /* ---------------- 会议操作 ---------------- */
  const handleEnd = useCallback(async () => {
    const ok = await requestConfirm({
      title: '结束会议',
      body: '结束后将生成本场纪要，你可以在纪要页继续编辑、导出。确定结束吗？',
      confirmText: '结束并整理',
      cancelText: '继续会议',
    });
    if (!ok) return;
    setEnding(true);
    try {
      const meetingId = await finish();
      if (meetingId) {
        toast.success('会议已结束，正在进入纪要页');
        navigate(`/review/${meetingId}`);
      }
    } finally {
      setEnding(false);
    }
  }, [finish, navigate, requestConfirm]);

  const handleTitleChange = useCallback((v: string) => {
    useMeetingStore.getState().patchMeeting({ title: v });
  }, []);

  const handleSelectSpeaker = useCallback((pid: string | null) => {
    useMeetingStore.getState().setCurrentSpeaker(pid);
  }, []);

  const handleAddParticipant = useCallback((name: string, role?: string) => {
    const p = useMeetingStore.getState().addParticipant(name, role);
    if (!p) {
      toast.warning(`参会人最多 ${MAX_PARTICIPANTS} 位`);
      return;
    }
    useMeetingStore.getState().setCurrentSpeaker(p.id);
  }, []);

  const handleUpdateParticipant = useCallback(
    (pid: string, patch: { name?: string; role?: string; colorIndex?: number }) => {
      useMeetingStore.getState().updateParticipant(pid, patch);
    },
    [],
  );

  const handleRemoveParticipant = useCallback((pid: string) => {
    useMeetingStore.getState().removeParticipant(pid);
  }, []);

  const handleSeek = useCallback(
    (ms: number) => {
      void seekPlay(ms);
    },
    [seekPlay],
  );

  const handleManualSubmit = useCallback(
    (text: string) => {
      pushManualText(text);
    },
    [pushManualText],
  );

  const handleManualBatch = useCallback(
    (text: string) => {
      const lines = text
        .split(/\r?\n+/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length === 0) return;
      const st = useMeetingStore.getState();
      const base = st.meeting ? st.elapsedMs() : 0;
      lines.forEach((l, i) => pushManualText(l, base + i * 1000));
      toast.success(`已导入 ${lines.length} 条外部转录`);
    },
    [pushManualText],
  );

  const status = meeting?.status ?? null;

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-2 p-3">
      <LiveTopBar
        title={meeting?.title ?? ''}
        onTitleChange={handleTitleChange}
        status={status}
        elapsedMs={elapsedMs}
        level={level}
        label={label}
        booting={booting}
        ending={ending}
        onPause={pause}
        onResume={resume}
        onEnd={handleEnd}
      />

      {level === 2 ? (
        <Alert severity="info">
          当前为本地手动模式（未授权麦克风或非 HTTPS 环境）：所有发言请在下方文本框录入，录音与实时识别不可用
        </Alert>
      ) : null}

      <SpeakerBar
        participants={participants}
        currentSpeakerId={currentSpeakerId}
        onSelect={handleSelectSpeaker}
        onAdd={handleAddParticipant}
        onUpdate={handleUpdateParticipant}
        onRemove={handleRemoveParticipant}
        maxReached={realCount >= MAX_PARTICIPANTS}
      />

      <Box sx={{ display: 'flex', minHeight: 0, flex: 1, flexDirection: 'column' }}>
        {manualOpen || level === 2 ? (
          <ManualPane onSubmit={handleManualSubmit} onBatch={handleManualBatch} />
        ) : null}
        <TranscriptList onSeek={handleSeek} className="mm-transcript flex-1" />
      </Box>

      <LiveBottomBar
        level={level}
        label={label}
        utteranceCount={utteranceCount}
        markerCount={markerCount}
        devices={devices}
        deviceId={mediaController.getDeviceId() || prefDeviceId}
        onDeviceChange={(d) => {
          void switchDevice(d);
        }}
        autoFollow={autoFollow}
        onToggleAutoFollow={setAutoFollow}
        hintText={hint?.text ?? null}
        onDismissHint={dismiss}
        saving={saving}
        dirty={dirty}
        lastSavedAt={lastSavedAt}
        manualOpen={manualOpen}
        onToggleManual={() => setManualOpen((v) => !v)}
        lastAtMs={lastAtMs}
      />

      {/* 时间码跳转用的隐藏播放器 */}
      <audio ref={audioRef} hidden />
    </div>
  );
}
