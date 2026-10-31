/**
 * 参会人头像条 + 当前发言人切换。
 *
 * - 最多 12 位真实参会人（不含系统保留的「未知发言人」，不计入上限、不可删除）；
 * - `Ctrl/Cmd + 1..9` 与头像上的数字角标一一对应（由 LivePage 监听 `mm:select-speaker` 统一处理）；
 * - 当前发言人高亮描边；点击头像即切换（<100ms）；
 * - 头像上的 `⋯` 可改名 / 换色 / 移除（移除后其发言 speakerId 置 null，绝不丢失）。
 */
import { useCallback, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import GroupsIcon from '@mui/icons-material/Groups';
import { SpeakerAvatar } from '@/components/common/UiKit';
import { SPEAKER_COLORS } from '@/theme';
import { toast } from '@/stores/useUiStore';
import { UNKNOWN_SPEAKER_ID, type Participant } from '@/types/models';

/** 头像条入参 */
export interface SpeakerBarProps {
  participants: Participant[];
  currentSpeakerId: string | null;
  onSelect: (id: string | null) => void;
  onAdd: (name: string, role?: string) => void;
  onUpdate: (id: string, patch: { name?: string; role?: string; colorIndex?: number }) => void;
  onRemove: (id: string) => void;
  /** 已达 12 人上限 */
  maxReached: boolean;
}

/** 参会人编辑弹窗状态 */
interface EditorState {
  open: boolean;
  mode: 'add' | 'edit';
  id: string;
  name: string;
  role: string;
  colorIndex: number;
}

const EMPTY_EDITOR: EditorState = { open: false, mode: 'add', id: '', name: '', role: '', colorIndex: 0 };

/**
 * 参会人头像条。
 */
export function SpeakerBar(props: SpeakerBarProps): JSX.Element {
  const { participants, currentSpeakerId, onSelect, onAdd, onUpdate, onRemove, maxReached } = props;

  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [menuId, setMenuId] = useState<string>('');

  /** 真实参会人（按 order 升序），「未知发言人」单独渲染在末尾 */
  const real: Participant[] = participants.filter((p) => p.id !== UNKNOWN_SPEAKER_ID).sort((a, b) => a.order - b.order);
  const unknown: Participant | undefined = participants.find((p) => p.id === UNKNOWN_SPEAKER_ID);

  const openAdd = useCallback(() => setEditor({ ...EMPTY_EDITOR, open: true, mode: 'add' }), []);
  const closeEditor = useCallback(() => setEditor((s) => ({ ...s, open: false })), []);

  const submitEditor = useCallback(() => {
    const name = editor.name.trim();
    if (!name) {
      toast.warning('请填写参会人姓名');
      return;
    }
    if (editor.mode === 'add') {
      onAdd(name, editor.role.trim() || undefined);
    } else {
      onUpdate(editor.id, { name, role: editor.role.trim() || undefined, colorIndex: editor.colorIndex });
    }
    closeEditor();
  }, [closeEditor, editor, onAdd, onUpdate]);

  return (
    <Paper variant="outlined" sx={{ px: 1.5, py: 1 }}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Tooltip title="参会人（最多 12 位）" arrow>
          <Chip size="small" icon={<GroupsIcon />} label={`${real.length}/12`} variant="outlined" sx={{ mr: 0.5 }} />
        </Tooltip>

        <Box sx={{ display: 'flex', gap: 1, overflowX: 'auto', py: 0.5, flex: 1 }}>
          {real.map((p, i) => {
            const selected = p.id === currentSpeakerId;
            return (
              <Stack key={p.id} direction="row" alignItems="center" spacing={0} sx={{ position: 'relative' }}>
                <Box sx={{ position: 'relative' }}>
                  <SpeakerAvatar
                    name={p.name}
                    colorIndex={p.colorIndex}
                    size={36}
                    selected={selected}
                    title={`${p.name}${p.role ? ` · ${p.role}` : ''}（快捷键 Ctrl/Cmd + ${i + 1}）`}
                    onClick={() => onSelect(p.id)}
                  />
                  {i < 9 ? (
                    <Box
                      sx={{
                        position: 'absolute',
                        right: -2,
                        bottom: -2,
                        minWidth: 16,
                        height: 16,
                        px: 0.3,
                        borderRadius: 999,
                        bgcolor: '#1E3A8A',
                        color: '#fff',
                        fontSize: 10,
                        fontWeight: 700,
                        lineHeight: '16px',
                        textAlign: 'center',
                      }}
                    >
                      {i + 1}
                    </Box>
                  ) : null}
                </Box>
                <IconButton
                  size="small"
                  sx={{ p: 0.25 }}
                  onClick={(e) => {
                    setMenuId(p.id);
                    setMenuAnchor(e.currentTarget);
                  }}
                  title="更多"
                >
                  <MoreVertIcon sx={{ fontSize: 14 }} />
                </IconButton>
                <Typography
                  variant="caption"
                  sx={{ maxWidth: 72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ml: 0.5 }}
                  color={selected ? 'primary' : 'text.secondary'}
                  fontWeight={selected ? 700 : 400}
                >
                  {p.name}
                </Typography>
              </Stack>
            );
          })}

          {unknown ? (
            <Stack direction="row" alignItems="center" spacing={0.5} sx={{ opacity: 0.85 }}>
              <SpeakerAvatar
                name={unknown.name}
                colorIndex={unknown.colorIndex}
                size={36}
                selected={currentSpeakerId === null}
                title="未归属发言（不可删除）"
                onClick={() => onSelect(null)}
              />
              <Typography variant="caption" color="text.secondary">
                {unknown.name}
              </Typography>
            </Stack>
          ) : null}
        </Box>

        <Button size="small" startIcon={<AddIcon />} onClick={openAdd} disabled={maxReached}>
          添加参会人
        </Button>
      </Stack>

      {/* 单个参会人菜单 */}
      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
        <MenuItem
          onClick={() => {
            const p = participants.find((x) => x.id === menuId);
            setMenuAnchor(null);
            if (p) onSelect(p.id);
          }}
        >
          设为当前发言人
        </MenuItem>
        <MenuItem
          onClick={() => {
            const p = participants.find((x) => x.id === menuId);
            setMenuAnchor(null);
            if (p) setEditor({ open: true, mode: 'edit', id: p.id, name: p.name, role: p.role ?? '', colorIndex: p.colorIndex });
          }}
        >
          改名 / 换色
        </MenuItem>
        <MenuItem
          sx={{ color: 'error.main' }}
          onClick={() => {
            setMenuAnchor(null);
            if (menuId && menuId !== UNKNOWN_SPEAKER_ID) onRemove(menuId);
          }}
        >
          移除（发言保留为「未知发言人」）
        </MenuItem>
      </Menu>

      {/* 新增 / 编辑弹窗 */}
      <Dialog open={editor.open} onClose={closeEditor} maxWidth="xs" fullWidth>
        <DialogTitle>{editor.mode === 'add' ? '添加参会人' : '编辑参会人'}</DialogTitle>
        <DialogContent className="flex flex-col gap-3">
          <TextField
            autoFocus
            size="small"
            label="姓名"
            value={editor.name}
            onChange={(e) => setEditor((s) => ({ ...s, name: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitEditor();
            }}
          />
          <TextField
            size="small"
            label="角色（可选）"
            placeholder="主持人 / 记录人 / 旁听…"
            value={editor.role}
            onChange={(e) => setEditor((s) => ({ ...s, role: e.target.value }))}
          />
          <Box>
            <Typography variant="caption" color="text.secondary">
              头像颜色（色觉友好配色）
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, mt: 0.5 }}>
              {SPEAKER_COLORS.map((c, i) => (
                <Box
                  key={c}
                  onClick={() => setEditor((s) => ({ ...s, colorIndex: i }))}
                  sx={{
                    width: 24,
                    height: 24,
                    borderRadius: 999,
                    bgcolor: c,
                    cursor: 'pointer',
                    boxShadow: editor.colorIndex === i ? '0 0 0 3px rgba(30,58,138,.35)' : 'none',
                  }}
                  title={`配色 ${i + 1}`}
                />
              ))}
            </Box>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeEditor}>取消</Button>
          <Button variant="contained" onClick={submitEditor}>
            保存
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}

export default SpeakerBar;
