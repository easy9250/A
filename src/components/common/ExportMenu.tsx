import { useCallback, useState } from 'react';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import CircularProgress from '@mui/material/CircularProgress';
import DescriptionIcon from '@mui/icons-material/Description';
import ArticleIcon from '@mui/icons-material/Article';
import DataObjectIcon from '@mui/icons-material/DataObject';
import PrintIcon from '@mui/icons-material/Print';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DownloadIcon from '@mui/icons-material/Download';
import type { MeetingSnapshot } from '@/types/models';
import { copyActionList, downloadExport, openPrintWindow } from '@/core/export';

export interface ExportMenuProps {
  /** 唯一数据源入口：由调用方提供 snapshot（通常是 store.getSnapshot()） */
  getSnapshot: () => MeetingSnapshot | null;
  disabled?: boolean;
  size?: 'small' | 'medium' | 'large';
  label?: string;
  /** 是否显示「复制待办清单」（P1-10） */
  showCopyActions?: boolean;
}

/**
 * 导出下拉菜单：Markdown / 纯文本 / JSON / 打印 HTML + 复制待办清单。
 * 所有格式统一从同一个 MeetingSnapshot 序列化，保证内容一致。
 */
export default function ExportMenu(props: ExportMenuProps): JSX.Element {
  const { getSnapshot, disabled = false, size = 'small', label = '导出', showCopyActions = true } = props;
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);

  const close = useCallback(() => setAnchorEl(null), []);

  const run = useCallback(
    (fn: (s: MeetingSnapshot) => void) => {
      close();
      const snap = getSnapshot();
      if (!snap) {
        setBusy(false);
        return;
      }
      try {
        fn(snap);
      } finally {
        setBusy(false);
      }
    },
    [close, getSnapshot],
  );

  const handleCopy = useCallback(() => {
    close();
    const snap = getSnapshot();
    if (!snap) return;
    setBusy(true);
    void copyActionList(snap, 'md').finally(() => setBusy(false));
  }, [close, getSnapshot]);

  return (
    <>
      <Button
        size={size}
        variant="outlined"
        startIcon={busy ? <CircularProgress size={14} color="inherit" /> : <DownloadIcon />}
        disabled={disabled || busy}
        onClick={(e) => setAnchorEl(e.currentTarget)}
      >
        {label}
      </Button>
      <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={close}>
        <MenuItem onClick={() => run((s) => downloadExport(s, 'md'))}>
          <ListItemIcon>
            <DescriptionIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Markdown（.md）" secondary="带议题/决议/待办表格/发言附录" />
        </MenuItem>
        <MenuItem onClick={() => run((s) => downloadExport(s, 'txt'))}>
          <ListItemIcon>
            <ArticleIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="纯文本（.txt）" secondary="内容一致，无标记语法" />
        </MenuItem>
        <MenuItem onClick={() => run((s) => downloadExport(s, 'json'))}>
          <ListItemIcon>
            <DataObjectIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="JSON 备份（.json）" secondary="完整快照，可重新导入" />
        </MenuItem>
        <MenuItem onClick={() => run((s) => openPrintWindow(s))}>
          <ListItemIcon>
            <PrintIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="打印 / 导出 PDF（HTML）" secondary="A4 分页，Ctrl/Cmd + P 可用" />
        </MenuItem>
        {showCopyActions ? (
          <>
            <Divider />
            <MenuItem onClick={handleCopy}>
              <ListItemIcon>
                <ContentCopyIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary="复制待办清单" secondary="Markdown 表格，可直接粘贴" />
            </MenuItem>
          </>
        ) : null}
      </Menu>
    </>
  );
}
