/**
 * 实时会议页的顶栏与底栏。
 *
 * - `LiveTopBar`：标题（可就地改）、累计计时、状态、暂停/继续/结束；
 * - `LiveBottomBar`：模式徽标、麦克风设备选择（切设备不中断录音）、音量条、
 *   自动跟随开关、能量突变非模态提示、保存状态、手动补录入口。
 */
import { useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import EditNoteIcon from '@mui/icons-material/EditNote';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import NoteAddIcon from '@mui/icons-material/NoteAdd';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import { mediaController, type AudioDeviceOption } from '@/core/audio/MediaController';
import { hhmmss, mmss } from '@/lib/utils';
import type { MeetingStatus, SpeechLevel } from '@/types/models';

/* ============================================================
 * 顶栏
 * ============================================================ */

export interface LiveTopBarProps {
  title: string;
  onTitleChange: (v: string) => void;
  status: MeetingStatus | null;
  /** 累计活动毫秒（不含暂停） */
  elapsedMs: number;
  level: SpeechLevel;
  label: string;
  booting: boolean;
  ending: boolean;
  onPause: () => void;
  onResume: () => void;
  onEnd: () => void;
}

/**
 * 实时会议页顶栏。
 */
export function LiveTopBar(props: LiveTopBarProps): JSX.Element {
  const { title, onTitleChange, status, elapsedMs, level, label, booting, ending, onPause, onResume, onEnd } = props;
  const active = status === 'active';
  const paused = status === 'paused';

  return (
    <Paper variant="outlined" sx={{ px: 1.5, py: 1 }}>
      <Stack direction="row" alignItems="center" spacing={1.5}>
        <TextField
          size="small"
          variant="standard"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder="会议标题"
          inputProps={{ 'aria-label': '会议标题' }}
          sx={{ flex: 1, minWidth: 120, maxWidth: 420, '& input': { fontSize: 16, fontWeight: 700 } }}
        />

        <Tooltip title="累计活动时长（不含暂停）" arrow>
          <Chip
            label={hhmmss(elapsedMs)}
            size="small"
            sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, letterSpacing: '.02em' }}
          />
        </Tooltip>

        {active ? (
          <Chip size="small" color="success" icon={<FiberManualRecordIcon />} label="进行中" />
        ) : paused ? (
          <Chip size="small" color="warning" label="已暂停" />
        ) : (
          <Chip size="small" label={status ?? '未开始'} />
        )}

        <Chip
          size="small"
          variant="outlined"
          color={level === 0 ? 'success' : level === 1 ? 'warning' : 'default'}
          label={booting ? '探测识别能力…' : label}
        />

        <Box sx={{ flex: 1 }} />

        {active ? (
          <Button size="small" variant="outlined" startIcon={<PauseIcon />} onClick={onPause}>
            暂停（空格）
          </Button>
        ) : (
          <Button
            size="small"
            variant="outlined"
            startIcon={<PlayArrowIcon />}
            onClick={onResume}
            disabled={status !== 'paused'}
          >
            继续（空格）
          </Button>
        )}
        <Button
          size="small"
          variant="contained"
          color="error"
          startIcon={<StopIcon />}
          onClick={onEnd}
          disabled={ending || !status || status === 'ended'}
        >
          {ending ? '结束中…' : '结束会议'}
        </Button>
      </Stack>
    </Paper>
  );
}

/* ============================================================
 * 音量条（直接改 DOM，避免高频 setState）
 * ============================================================ */

/**
 * 音量条：每 66ms（≈4 帧）读一次 `mediaController.getLevel()`，直接改宽度样式。
 */
export function LevelMeter(): JSX.Element {
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => {
      const el = barRef.current;
      if (!el) return;
      const v = Math.max(0, Math.min(1, mediaController.getLevel()));
      el.style.width = `${Math.round(v * 100)}%`;
    }, 66);
    return () => window.clearInterval(id);
  }, []);

  return (
    <Tooltip title="麦克风音量" arrow>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 90 }}>
        <VolumeUpIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
        <Box sx={{ flex: 1, height: 6, borderRadius: 999, bgcolor: 'rgba(0,0,0,.08)', overflow: 'hidden' }}>
          <Box
            ref={barRef}
            sx={{ height: '100%', width: '0%', bgcolor: '#009E73', transition: 'width .06s linear' }}
          />
        </Box>
      </Box>
    </Tooltip>
  );
}

/* ============================================================
 * 底栏
 * ============================================================ */

export interface LiveBottomBarProps {
  level: SpeechLevel;
  label: string;
  utteranceCount: number;
  markerCount: number;
  devices: AudioDeviceOption[];
  deviceId: string;
  onDeviceChange: (id: string) => void;
  autoFollow: boolean;
  onToggleAutoFollow: (v: boolean) => void;
  /** P1-05 能量突变提示文案；null 表示无 */
  hintText: string | null;
  onDismissHint: () => void;
  saving: boolean;
  dirty: boolean;
  lastSavedAt: number | null;
  manualOpen: boolean;
  onToggleManual: () => void;
  /** 最近一条发言的相对毫秒（用于提示展示） */
  lastAtMs: number;
}

/**
 * 实时会议页底栏。
 */
export function LiveBottomBar(props: LiveBottomBarProps): JSX.Element {
  const {
    level,
    label,
    utteranceCount,
    markerCount,
    devices,
    deviceId,
    onDeviceChange,
    autoFollow,
    onToggleAutoFollow,
    hintText,
    onDismissHint,
    saving,
    dirty,
    lastSavedAt,
    manualOpen,
    onToggleManual,
    lastAtMs,
  } = props;

  return (
    <Paper variant="outlined" sx={{ px: 1.5, py: 0.75 }}>
      <Stack direction="row" alignItems="center" spacing={1.5}>
        <Chip
          size="small"
          color={level === 0 ? 'success' : level === 1 ? 'warning' : 'default'}
          variant="outlined"
          label={label}
        />
        <Typography variant="caption" color="text.secondary">
          {utteranceCount} 条发言
          {markerCount > 0 ? ` · ${markerCount} 处标记` : ''}
          {lastAtMs > 0 ? ` · 最新 ${mmss(lastAtMs)}` : ''}
        </Typography>

        <LevelMeter />

        <TextField
          select
          size="small"
          label="麦克风"
          value={deviceId}
          onChange={(e) => onDeviceChange(String(e.target.value))}
          sx={{ minWidth: 160, maxWidth: 240 }}
        >
          <MenuItem value="">系统默认</MenuItem>
          {devices.map((d) => (
            <MenuItem key={d.deviceId} value={d.deviceId}>
              {d.label}
            </MenuItem>
          ))}
        </TextField>

        <FormControlLabel
          control={<Switch size="small" checked={autoFollow} onChange={(e) => onToggleAutoFollow(e.target.checked)} />}
          label={<Typography variant="caption">自动跟随</Typography>}
        />

        <Box sx={{ flex: 1 }} />

        {hintText ? (
          <Chip
            size="small"
            color="info"
            variant="outlined"
            label={hintText}
            onDelete={onDismissHint}
            deleteIcon={<CloseIcon />}
            sx={{ maxWidth: 420 }}
          />
        ) : null}

        <Typography variant="caption" color="text.secondary">
          {saving ? '保存中…' : dirty ? '有未保存改动' : lastSavedAt ? '已保存' : '等待第一条发言'}
        </Typography>

        <Divider flexItem orientation="vertical" sx={{ mx: 0.5 }} />

        <Tooltip title="手动补录一条发言（L1/L2 亦可粘贴外部转录）" arrow>
          <Button
            size="small"
            variant={manualOpen ? 'contained' : 'outlined'}
            startIcon={manualOpen ? <EditNoteIcon /> : <NoteAddIcon />}
            onClick={onToggleManual}
          >
            手动补录
          </Button>
        </Tooltip>
      </Stack>
    </Paper>
  );
}
