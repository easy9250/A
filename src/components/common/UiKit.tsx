import React from 'react';
import Avatar from '@mui/material/Avatar';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { speakerColor } from '@/theme';
import { useUiStore } from '@/stores/useUiStore';

/* ============================================================
 * ConfirmDialog —— 二次确认弹窗（结束会议 / 删除会议等）
 * 用法：const ok = await useUiStore.getState().requestConfirm({title, body, danger})
 * 全局宿主已在 App.tsx 挂载，任意位置调用即可。
 * ============================================================ */
export function ConfirmDialog(): JSX.Element {
  const confirm = useUiStore((s) => s.confirm);
  const resolveConfirm = useUiStore((s) => s.resolveConfirm);

  return (
    <Dialog
      open={confirm.open}
      onClose={() => resolveConfirm(false)}
      maxWidth="xs"
      fullWidth
      aria-labelledby="mm-confirm-title"
    >
      <DialogTitle id="mm-confirm-title">{confirm.title}</DialogTitle>
      {confirm.body ? (
        <DialogContent>
          <DialogContentText>{confirm.body}</DialogContentText>
        </DialogContent>
      ) : null}
      <DialogActions>
        <Button onClick={() => resolveConfirm(false)} color="inherit">
          {confirm.cancelText}
        </Button>
        <Button
          onClick={() => resolveConfirm(true)}
          variant="contained"
          color={confirm.danger ? 'error' : 'primary'}
          autoFocus
        >
          {confirm.confirmText}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/* ============================================================
 * EmptyState —— 空态（插画 + 说明 + CTA）
 * ============================================================ */
export interface EmptyStateProps {
  title: string;
  description?: string;
  actionText?: string;
  onAction?: () => void;
  secondaryText?: string;
  onSecondary?: () => void;
  icon?: React.ReactNode;
}

export function EmptyState(props: EmptyStateProps): JSX.Element {
  const { title, description, actionText, onAction, secondaryText, onSecondary, icon } = props;
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        {icon ?? <span className="text-2xl">🗒️</span>}
      </div>
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      {description ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 420 }}>
          {description}
        </Typography>
      ) : null}
      {actionText && onAction ? (
        <div className="mt-4 flex items-center gap-2">
          <Button variant="contained" onClick={onAction}>
            {actionText}
          </Button>
          {secondaryText && onSecondary ? (
            <Button variant="text" onClick={onSecondary}>
              {secondaryText}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ============================================================
 * SpeakerAvatar —— 按 colorIndex 取色的圆形头像（取姓名首字）
 * ============================================================ */
export interface SpeakerAvatarProps {
  name: string;
  colorIndex: number;
  size?: number;
  /** 当前发言人：加高亮描边 */
  selected?: boolean;
  /** 灰显（如已删除 / 未归属） */
  muted?: boolean;
  onClick?: () => void;
  title?: string;
}

export function SpeakerAvatar(props: SpeakerAvatarProps): JSX.Element {
  const { name, colorIndex, size = 32, selected = false, muted = false, onClick, title } = props;
  const bg = muted ? '#9CA3AF' : speakerColor(colorIndex);
  const initial = (name ?? '?').trim().slice(0, 1) || '?';
  const avatar = (
    <Avatar
      onClick={onClick}
      title={title ?? name}
      sx={{
        width: size,
        height: size,
        fontSize: size * 0.45,
        fontWeight: 700,
        bgcolor: bg,
        cursor: onClick ? 'pointer' : 'default',
        boxShadow: selected ? `0 0 0 3px ${bg}` : 'none',
        outline: selected ? '2px solid #fff' : 'none',
        opacity: muted ? 0.6 : 1,
        transition: 'box-shadow .15s ease',
      }}
    >
      {initial}
    </Avatar>
  );
  return title ? (
    <Tooltip title={title} arrow>
      {avatar}
    </Tooltip>
  ) : (
    avatar
  );
}
