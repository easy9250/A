import { useCallback, useMemo, useState } from 'react';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import CallMadeIcon from '@mui/icons-material/CallMade';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import type {
  ActionItem,
  ActionPriority,
  Decision,
  MeetingSnapshot,
  Participant,
  Utterance,
} from '@/types/models';
import { UNKNOWN_SPEAKER_ID } from '@/types/models';
import { hhmmss, relDueDateCN } from '@/lib/utils';
import { getRepo } from '@/core/repo';
import { mediaController } from '@/core/audio/MediaController';
import { copyActionList } from '@/core/export';
import { SpeakerAvatar } from '@/components/common/UiKit';
import { toast } from '@/stores/useUiStore';

/** MediaController 的极简形态（具体实现由 T04 同学维护，这里按名调用） */
interface MediaControllerLike {
  loadAudio?: (blob: Blob | null) => Promise<void> | void;
  seekToRelMs?: (ms: number) => void;
  play?: () => Promise<void> | void;
  /** 便捷方法：直接用内存录音分片按相对毫秒起播；无分片时返回 false */
  playFrom?: (relMs: number) => Promise<boolean>;
}

/** 播放控制：直接复用 MediaController 单例 */
async function getMediaController(): Promise<MediaControllerLike> {
  return mediaController as unknown as MediaControllerLike;
}

/** 溯源跳转 + 播放录音：先滚动定位（由页面处理），再按相对毫秒 seek */
export async function playFromUtterance(meetingId: string, utterance: Utterance): Promise<void> {
  const ctl = await getMediaController();
  if (!ctl || typeof ctl.loadAudio !== 'function') {
    toast.info('该会议没有可用录音，已跳转到原文位置');
    return;
  }
  const ms = Math.max(0, utterance.startMs);
  try {
    // ① 优先用内存录音分片（会中实时场景，零延迟）
    if (typeof ctl.playFrom === 'function') {
      const ok = await ctl.playFrom(ms);
      if (ok) return;
    }
    // ② 回退：从 IndexedDB 读回音频后 seek（刷新/历史会议场景）
    const blob = await getRepo().getAudio(meetingId);
    if (!blob) {
      toast.info('该会议没有可用录音，已跳转到原文位置');
      return;
    }
    await ctl.loadAudio(blob);
    ctl.seekToRelMs?.(ms);
    await ctl.play?.();
  } catch {
    toast.info('录音播放失败，已跳转到原文位置');
  }
}

/* ============================================================
 * 决议面板
 * ============================================================ */
export interface DecisionPanelProps {
  meetingId: string;
  decisions: Decision[];
  utterances: Utterance[];
  onUpdate: (id: string, patch: Partial<Pick<Decision, 'content' | 'confirmed' | 'origin'>>) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
  onLocate: (utteranceId: string) => void;
}

export function DecisionPanel(props: DecisionPanelProps): JSX.Element {
  const { meetingId, decisions, utterances, onUpdate, onRemove, onAdd, onLocate } = props;

  const locate = useCallback(
    (u: Utterance | undefined) => {
      if (!u) return;
      onLocate(u.id);
      void playFromUtterance(meetingId, u);
    },
    [meetingId, onLocate],
  );

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
          <Typography variant="subtitle2">✅ 决议</Typography>
          <Chip size="small" label={decisions.length} />
          <div style={{ flex: 1 }} />
          <Tooltip title="新增决议" arrow>
            <IconButton size="small" color="primary" onClick={onAdd}>
              <AddIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>

        {decisions.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            暂无决议，可在上方新增或点击「AI 重新整理」生成
          </Typography>
        ) : (
          decisions.map((d) => {
            const src = d.sourceUtteranceIds.map((id) => utterances.find((u) => u.id === id)).filter(Boolean) as Utterance[];
            const isCandidate = d.origin !== 'manual' && !d.confirmed;
            return (
              <Stack
                key={d.id}
                direction="row"
                spacing={1}
                alignItems="flex-start"
                sx={{
                  mb: 1,
                  p: 1,
                  borderRadius: 1.5,
                  border: '1px solid',
                  borderStyle: isCandidate ? 'dashed' : 'solid',
                  borderColor: isCandidate ? 'warning.main' : 'divider',
                  bgcolor: isCandidate ? 'rgba(230,159,0,0.03)' : 'transparent',
                }}
              >
                <Tooltip title={d.confirmed ? '取消确认' : '确认该决议'} arrow>
                  <Checkbox
                    size="small"
                    checked={d.confirmed}
                    onChange={(e) => onUpdate(d.id, { confirmed: e.target.checked, origin: 'manual' })}
                  />
                </Tooltip>
                <TextField
                  fullWidth
                  size="small"
                  variant="standard"
                  multiline
                  value={d.content}
                  onChange={(e) => onUpdate(d.id, { content: e.target.value, origin: 'manual' })}
                />
                <Stack direction="row" alignItems="center" spacing={0.5} sx={{ pt: 0.5 }}>
                  {src.length > 0 ? (
                    <Tooltip title={`溯源 ${src.length} 条 · ${hhmmss(src[0].startMs)}（点击跳转并播放）`} arrow>
                      <IconButton size="small" onClick={() => locate(src[0])}>
                        <CallMadeIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : null}
                  {isCandidate ? (
                    <Tooltip title="标记为已确认" arrow>
                      <IconButton size="small" color="success" onClick={() => onUpdate(d.id, { confirmed: true })}>
                        <CheckCircleOutlineIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : null}
                  <Tooltip title="删除" arrow>
                    <IconButton size="small" color="error" onClick={() => onRemove(d.id)}>
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Stack>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

/* ============================================================
 * 待办面板
 * ============================================================ */
export interface ActionPanelProps {
  meetingId: string;
  actionItems: ActionItem[];
  utterances: Utterance[];
  participants: Participant[];
  getSnapshot?: () => MeetingSnapshot | null;
  onUpdate: (
    id: string,
    patch: Partial<Pick<ActionItem, 'content' | 'assigneeId' | 'dueDate' | 'priority' | 'status' | 'origin'>>,
  ) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
  onLocate: (utteranceId: string) => void;
}

export function ActionPanel(props: ActionPanelProps): JSX.Element {
  const { meetingId, actionItems, utterances, participants, getSnapshot, onUpdate, onRemove, onAdd, onLocate } = props;
  const [copied, setCopied] = useState(false);

  const options = useMemo(
    () => participants.filter((p) => p.id !== UNKNOWN_SPEAKER_ID),
    [participants],
  );

  const locate = useCallback(
    (u: Utterance | undefined) => {
      if (!u) return;
      onLocate(u.id);
      void playFromUtterance(meetingId, u);
    },
    [meetingId, onLocate],
  );

  const handleCopy = useCallback(async () => {
    const snap = getSnapshot?.() ?? null;
    if (!snap) return;
    setCopied(true);
    await copyActionList(snap, 'md');
    setCopied(false);
  }, [getSnapshot]);

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
          <Typography variant="subtitle2">📋 待办事项</Typography>
          <Chip size="small" label={actionItems.length} />
          <div style={{ flex: 1 }} />
          <Tooltip title="复制待办清单到剪贴板" arrow>
            <span>
              <IconButton size="small" onClick={handleCopy} disabled={!getSnapshot || copied}>
                <ContentCopyIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="新增待办" arrow>
            <IconButton size="small" color="primary" onClick={onAdd}>
              <AddIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>

        {actionItems.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            暂无待办，可在上方新增或点击「AI 重新整理」生成
          </Typography>
        ) : (
          actionItems.map((a) => {
            const src = a.sourceUtteranceIds.map((id) => utterances.find((u) => u.id === id)).filter(Boolean) as Utterance[];
            const isCandidate = a.origin !== 'manual' && a.status !== 'done';
            const owner = participants.find((p) => p.id === a.assigneeId);
            return (
              <Stack
                key={a.id}
                spacing={1}
                sx={{
                  mb: 1.5,
                  p: 1.25,
                  borderRadius: 1.5,
                  border: '1px solid',
                  borderStyle: isCandidate ? 'dashed' : 'solid',
                  borderColor: isCandidate ? 'warning.main' : 'divider',
                  bgcolor: isCandidate ? 'rgba(230,159,0,0.03)' : 'transparent',
                }}
              >
                <Stack direction="row" spacing={1} alignItems="flex-start">
                  <Tooltip title={a.status === 'done' ? '标记未完成' : '标记已完成'} arrow>
                    <Checkbox
                      size="small"
                      checked={a.status === 'done'}
                      onChange={(e) => onUpdate(a.id, { status: e.target.checked ? 'done' : 'todo' })}
                    />
                  </Tooltip>
                  <TextField
                    fullWidth
                    size="small"
                    variant="standard"
                    multiline
                    value={a.content}
                    onChange={(e) => onUpdate(a.id, { content: e.target.value, origin: 'manual' })}
                    sx={{ textDecoration: a.status === 'done' ? 'line-through' : 'none' }}
                  />
                  {src.length > 0 ? (
                    <Tooltip title={`溯源 · ${hhmmss(src[0].startMs)}（点击跳转并播放）`} arrow>
                      <IconButton size="small" onClick={() => locate(src[0])}>
                        <CallMadeIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : null}
                  <Tooltip title="删除" arrow>
                    <IconButton size="small" color="error" onClick={() => onRemove(a.id)}>
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Stack>

                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  {owner ? (
                    <SpeakerAvatar name={owner.name} colorIndex={owner.colorIndex} size={22} />
                  ) : (
                    <Chip size="small" variant="outlined" label="未指定负责人" />
                  )}
                  <TextField
                    select
                    size="small"
                    label="负责人"
                    value={a.assigneeId ?? ''}
                    onChange={(e) => onUpdate(a.id, { assigneeId: e.target.value || null, origin: 'manual' })}
                    sx={{ minWidth: 120 }}
                  >
                    <MenuItem value="">未指定</MenuItem>
                    {options.map((p) => (
                      <MenuItem key={p.id} value={p.id}>
                        {p.name}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField
                    size="small"
                    type="date"
                    label="截止"
                    value={a.dueDate ?? ''}
                    onChange={(e) => onUpdate(a.id, { dueDate: e.target.value || null, origin: 'manual' })}
                    InputLabelProps={{ shrink: true }}
                    sx={{ minWidth: 150 }}
                  />
                  <TextField
                    select
                    size="small"
                    label="优先级"
                    value={a.priority}
                    onChange={(e) => onUpdate(a.id, { priority: e.target.value as ActionPriority, origin: 'manual' })}
                    sx={{ minWidth: 96 }}
                  >
                    <MenuItem value="P0">P0</MenuItem>
                    <MenuItem value="P1">P1</MenuItem>
                    <MenuItem value="P2">P2</MenuItem>
                  </TextField>
                  {a.dueDate ? (
                    <Chip size="small" variant="outlined" label={relDueDateCN(a.dueDate)} />
                  ) : null}
                  {src.length > 0 ? (
                    <Chip
                      size="small"
                      icon={<PlayArrowIcon />}
                      label={hhmmss(src[0].startMs)}
                      onClick={() => locate(src[0])}
                      variant="outlined"
                    />
                  ) : null}
                </Stack>
              </Stack>
            );
          })
        )}
        <Divider sx={{ mt: 1 }} />
        <Typography variant="caption" color="text.secondary">
          虚线卡片为待确认候选，编辑或勾选后转为实线；↗ 可跳转到原始发言并播放录音
        </Typography>
      </CardContent>
    </Card>
  );
}
