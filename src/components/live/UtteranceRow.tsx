/**
 * 单条发言行。
 *
 * 性能约定（★ 600 条不卡的前提）：
 * - `React.memo` 包裹；
 * - 只订阅 `useMeetingStore(s => s.uttMap[id])`，父级 append 不触发本行重渲染；
 * - 所有回调由父级 `useCallback` 传入，引用稳定。
 *
 * 交互（T04 验收项）：
 * - 时间码按钮 → 跳录音播放；
 * - 发言人按钮 → 归属下拉（≤2 次点击）；
 * - 双击正文 → 就地编辑（Enter 提交 / Esc 取消）；
 * - ⭐ 打点（P1-07）；
 * - `[⋯]` 菜单：合并下一条、从此处起批量改归属（带影响条数预览）、标记、复制、删除。
 */
import React, { useCallback, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import LoopIcon from '@mui/icons-material/Loop';
import FlagIcon from '@mui/icons-material/Flag';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CallMergeIcon from '@mui/icons-material/CallMerge';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PersonIcon from '@mui/icons-material/Person';
import { SpeakerAvatar } from '@/components/common/UiKit';
import { selectUtterance, useMeetingStore } from '@/stores/useMeetingStore';
import { speakerColor } from '@/theme';
import { timecodeOf } from '@/lib/utils';
import type { MarkerKind, Participant, Utterance } from '@/types/models';

/** 行组件入参 */
export interface UtteranceRowProps {
  id: string;
  participants: Participant[];
  /** 时间码 → 跳录音播放 */
  onSeek: (startMs: number) => void;
  onCopy: (text: string) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onReassign: (id: string, speakerId: string | null) => void;
  /** 「从此处起批量改为 X」 */
  onReassignFromHere: (id: string, speakerId: string | null) => void;
  onMarker: (id: string, kind: MarkerKind | null) => void;
  /** 与下一条合并 */
  onMergeNext: (id: string) => void;
  /** 在光标处拆分 */
  onSplit: (id: string, at: number) => void;
}

/** 打点类型 → 展示元数据 */
const MARKER_META: Record<MarkerKind, { text: string; icon: JSX.Element; color: string }> = {
  important: { text: '重要', icon: <StarIcon fontSize="inherit" />, color: '#E69F00' },
  question: { text: '问题', icon: <HelpOutlineIcon fontSize="inherit" />, color: '#0072B2' },
  followup: { text: '跟进', icon: <LoopIcon fontSize="inherit" />, color: '#009E73' },
};

/** 取发言人展示信息（未归属 → 未知发言人 / 灰色） */
function speakerOf(participants: Participant[], id: string | null): { name: string; colorIndex: number } {
  if (!id) return { name: '未知发言人', colorIndex: 7 };
  const p = participants.find((x) => x.id === id);
  if (!p) return { name: '未知发言人', colorIndex: 7 };
  return { name: p.name, colorIndex: p.colorIndex };
}

/**
 * 单条发言行（memo）。
 */
function UtteranceRowBase(props: UtteranceRowProps): JSX.Element {
  const { id, participants, onSeek, onCopy, onEdit, onDelete, onReassign, onReassignFromHere, onMarker, onMergeNext, onSplit } =
    props;

  // ★ 单行订阅：只有本条 utterance 变更时才重渲染
  const select = useMemo(() => selectUtterance(id), [id]);
  const utt: Utterance | undefined = useMeetingStore(select);

  const [editing, setEditing] = useState<boolean>(false);
  const [draft, setDraft] = useState<string>('');
  const [nameAnchor, setNameAnchor] = useState<HTMLElement | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [subAnchor, setSubAnchor] = useState<HTMLElement | null>(null);
  const [subKind, setSubKind] = useState<'fromHere' | null>(null);
  const [fromHereCount, setFromHereCount] = useState<number>(0);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

  const speaker = speakerOf(participants, utt?.speakerId ?? null);
  const color = speakerColor(speaker.colorIndex);

  const commitEdit = useCallback(() => {
    const next = draft.trim();
    if (next && utt && next !== utt.text) onEdit(id, next);
    setEditing(false);
    setDraft('');
  }, [draft, id, onEdit, utt]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setDraft('');
  }, []);

  const openFromHere = useCallback(() => {
    setFromHereCount(useMeetingStore.getState().previewReassignFromHere(id));
    setSubKind('fromHere');
    setSubAnchor(menuAnchor);
    setMenuAnchor(null);
  }, [id, menuAnchor]);

  if (!utt) return <div />;

  const markerMeta = utt.marker ? MARKER_META[utt.marker] : null;

  return (
    <Box
      sx={{
        px: 1,
        py: 0.5,
        borderLeft: `3px solid ${color}`,
        bgcolor: utt.starred ? 'rgba(230,159,0,.06)' : 'transparent',
        '&:hover': { bgcolor: 'rgba(30,58,138,.04)' },
      }}
      data-utt-id={utt.id}
    >
      <Stack direction="row" alignItems="flex-start" spacing={1}>
        {/* 时间码 → 跳录音 */}
        <Tooltip title="跳到此处回听" arrow>
          <Button
            size="small"
            variant="text"
            startIcon={<PlayArrowIcon sx={{ fontSize: 14 }} />}
            onClick={() => onSeek(utt.startMs)}
            sx={{ minWidth: 0, px: 0.5, color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}
          >
            {timecodeOf(utt.startMs)}
          </Button>
        </Tooltip>

        <SpeakerAvatar name={speaker.name} colorIndex={speaker.colorIndex} size={28} />

        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 0.25 }}>
            {/* 归属下拉：1 次点击开菜单，1 次点击选人 = ≤2 次点击 */}
            <Button
              size="small"
              onClick={(e) => setNameAnchor(e.currentTarget)}
              sx={{ minWidth: 0, px: 0.5, color, fontWeight: 700, fontSize: 13 }}
              endIcon={<PersonIcon sx={{ fontSize: 12, opacity: 0.6 }} />}
            >
              {speaker.name}
            </Button>
            {markerMeta ? (
              <Chip
                size="small"
                icon={markerMeta.icon}
                label={markerMeta.text}
                sx={{ height: 20, fontSize: 11, color: markerMeta.color, borderColor: markerMeta.color }}
                variant="outlined"
              />
            ) : null}
            {utt.source === 'manual' ? (
              <Chip size="small" label="手动" sx={{ height: 20, fontSize: 11 }} variant="outlined" />
            ) : null}
            <Box sx={{ flex: 1 }} />
            <IconButton
              size="small"
              onClick={() => onMarker(id, utt.starred ? null : 'important')}
              sx={{ color: utt.starred ? '#E69F00' : 'text.disabled' }}
              title="打点（Ctrl/Cmd + M）"
            >
              {utt.starred ? <StarIcon sx={{ fontSize: 16 }} /> : <StarBorderIcon sx={{ fontSize: 16 }} />}
            </IconButton>
            <IconButton size="small" onClick={(e) => setMenuAnchor(e.currentTarget)} title="更多操作">
              <MoreHorizIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Stack>

          {editing ? (
            <Box>
              <TextField
                multiline
                fullWidth
                autoFocus
                size="small"
                minRows={2}
                maxRows={8}
                value={draft}
                inputRef={textareaRef}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    commitEdit();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelEdit();
                  }
                }}
              />
              <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
                <Button size="small" variant="contained" onClick={commitEdit}>
                  保存
                </Button>
                <Button size="small" color="inherit" onClick={cancelEdit}>
                  取消
                </Button>
                <Button
                  size="small"
                  startIcon={<CallSplitIcon sx={{ fontSize: 14 }} />}
                  onClick={() => {
                    const caret = textareaRef.current?.selectionStart ?? Math.floor(draft.length / 2);
                    onEdit(id, draft.trim());
                    onSplit(id, caret);
                    setEditing(false);
                    setDraft('');
                  }}
                >
                  在光标处拆分
                </Button>
              </Stack>
            </Box>
          ) : (
            <Typography
              variant="body2"
              onDoubleClick={() => {
                setDraft(utt.text);
                setEditing(true);
              }}
              sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', cursor: 'text' }}
              title="双击编辑"
            >
              {utt.text}
            </Typography>
          )}
        </Box>
      </Stack>

      {/* 归属下拉 */}
      <Menu anchorEl={nameAnchor} open={Boolean(nameAnchor)} onClose={() => setNameAnchor(null)}>
        {participants
          .filter((p) => p.id !== 'unknown')
          .map((p) => (
            <MenuItem
              key={p.id}
              selected={p.id === utt.speakerId}
              onClick={() => {
                onReassign(id, p.id);
                setNameAnchor(null);
              }}
            >
              <ListItemIcon sx={{ minWidth: 28 }}>
                <SpeakerAvatar name={p.name} colorIndex={p.colorIndex} size={20} />
              </ListItemIcon>
              <ListItemText>{p.name}</ListItemText>
            </MenuItem>
          ))}
        <Divider />
        <MenuItem
          selected={utt.speakerId === null}
          onClick={() => {
            onReassign(id, null);
            setNameAnchor(null);
          }}
        >
          <ListItemText>未知发言人</ListItemText>
        </MenuItem>
      </Menu>

      {/* [⋯] 菜单 */}
      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
        <MenuItem
          onClick={() => {
            onCopy(utt.text);
            setMenuAnchor(null);
          }}
        >
          <ListItemIcon>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>复制文本</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            onMarker(id, 'important');
            setMenuAnchor(null);
          }}
        >
          <ListItemIcon>
            <StarIcon fontSize="small" sx={{ color: '#E69F00' }} />
          </ListItemIcon>
          <ListItemText>标记：重要</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            onMarker(id, 'question');
            setMenuAnchor(null);
          }}
        >
          <ListItemIcon>
            <HelpOutlineIcon fontSize="small" sx={{ color: '#0072B2' }} />
          </ListItemIcon>
          <ListItemText>标记：问题</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            onMarker(id, 'followup');
            setMenuAnchor(null);
          }}
        >
          <ListItemIcon>
            <LoopIcon fontSize="small" sx={{ color: '#009E73' }} />
          </ListItemIcon>
          <ListItemText>标记：跟进</ListItemText>
        </MenuItem>
        {utt.marker ? (
          <MenuItem
            onClick={() => {
              onMarker(id, null);
              setMenuAnchor(null);
            }}
          >
            <ListItemIcon>
              <FlagIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>清除标记</ListItemText>
          </MenuItem>
        ) : null}
        <Divider />
        <MenuItem onClick={openFromHere}>
          <ListItemText>从此处起批量改为…</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            onMergeNext(id);
            setMenuAnchor(null);
          }}
        >
          <ListItemIcon>
            <CallMergeIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>与下一条合并</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem
          sx={{ color: 'error.main' }}
          onClick={() => {
            setMenuAnchor(null);
            onDelete(id);
          }}
        >
          <ListItemIcon>
            <DeleteOutlineIcon fontSize="small" color="error" />
          </ListItemIcon>
          <ListItemText>删除这条发言</ListItemText>
        </MenuItem>
      </Menu>

      {/* 「从此处起批量改为 X」子菜单（带影响条数预览） */}
      <Menu anchorEl={subAnchor} open={Boolean(subAnchor) && subKind === 'fromHere'} onClose={() => setSubAnchor(null)}>
        <MenuItem disabled>
          <ListItemText sx={{ color: 'text.secondary' }}>影响 {fromHereCount} 条发言</ListItemText>
        </MenuItem>
        <Divider />
        {participants.map((p) => (
          <MenuItem
            key={p.id}
            onClick={() => {
              setSubAnchor(null);
              onReassignFromHere(id, p.id === 'unknown' ? null : p.id);
            }}
          >
            <ListItemIcon sx={{ minWidth: 28 }}>
              <SpeakerAvatar name={p.name} colorIndex={p.colorIndex} size={20} />
            </ListItemIcon>
            <ListItemText>{p.name}</ListItemText>
          </MenuItem>
        ))}
      </Menu>
    </Box>
  );
}

/** memo 化：父级 append 时本行不重渲染 */
export const UtteranceRow = React.memo(UtteranceRowBase);

export default UtteranceRow;
