import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DownloadIcon from '@mui/icons-material/Download';
import EditNoteIcon from '@mui/icons-material/EditNote';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import SearchIcon from '@mui/icons-material/Search';
import type { MeetingSnapshot, MeetingSummary } from '@/types/models';
import { getRepo } from '@/core/repo';
import { downloadExport, openPrintWindow } from '@/core/export';
import { EmptyState, SpeakerAvatar } from '@/components/common/UiKit';
import { useUiStore } from '@/stores/useUiStore';
import { debounce, fmtDateTime, fmtDurCN } from '@/lib/utils';

/** 搜索防抖（P0-16②） */
const SEARCH_DEBOUNCE_MS = 300;
/** 卡片估算高度（虚拟滚动用） */
const CARD_HEIGHT = 148;

type FilterMode = 'all' | 'hasAction' | 'openAction';

/** 单卡导出菜单：按需加载快照后导出，避免一次性读入全部会议 */
function CardExportMenu(props: { meetingId: string }): JSX.Element {
  const { meetingId } = props;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (fn: (snap: MeetingSnapshot) => void) => {
      setAnchor(null);
      setBusy(true);
      try {
        const snap = await getRepo().loadSnapshot(meetingId);
        if (snap) fn(snap);
      } finally {
        setBusy(false);
      }
    },
    [meetingId],
  );

  return (
    <>
      <Tooltip title="导出" arrow>
        <span>
          <IconButton size="small" disabled={busy} onClick={(e) => setAnchor(e.currentTarget)}>
            {busy ? <CircularProgress size={16} /> : <DownloadIcon fontSize="small" />}
          </IconButton>
        </span>
      </Tooltip>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
        <MenuItem onClick={() => void run((s) => downloadExport(s, 'md'))}>Markdown（.md）</MenuItem>
        <MenuItem onClick={() => void run((s) => downloadExport(s, 'txt'))}>纯文本（.txt）</MenuItem>
        <MenuItem onClick={() => void run((s) => downloadExport(s, 'json'))}>JSON 备份（.json）</MenuItem>
        <MenuItem onClick={() => void run((s) => openPrintWindow(s))}>打印 / PDF（HTML）</MenuItem>
      </Menu>
    </>
  );
}

/**
 * 历史会议页（页面 C）：300ms 防抖搜索 + 筛选 + 虚拟滚动卡片列表 + 打开/导出/删除。
 */
export default function HistoryPage(): JSX.Element {
  const navigate = useNavigate();
  const requestConfirm = useUiStore((s) => s.requestConfirm);
  const toast = useUiStore((s) => s.toast);

  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [list, setList] = useState<MeetingSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  /* ---------------- 300ms 防抖搜索 ---------------- */
  const applyKeyword = useMemo(
    () =>
      debounce((v: string) => {
        setAppliedKeyword(v);
      }, SEARCH_DEBOUNCE_MS),
    [],
  );
  useEffect(() => () => applyKeyword.cancel(), [applyKeyword]);

  const onSearchChange = useCallback(
    (v: string) => {
      setKeyword(v);
      applyKeyword(v);
    },
    [applyKeyword],
  );

  /* Ctrl/Cmd + K 聚焦搜索框（App.tsx 派发 mm:focus-search） */
  useEffect(() => {
    const onFocus = (): void => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('mm:focus-search', onFocus);
    return () => window.removeEventListener('mm:focus-search', onFocus);
  }, []);

  /* ---------------- 拉列表 ---------------- */
  const reload = useCallback(async () => {
    setLoading(true);
    const data = await getRepo().listSummaries({
      keyword: appliedKeyword || undefined,
      hasOpenAction: filter === 'openAction' || undefined,
    });
    setList(data);
    setLoading(false);
  }, [appliedKeyword, filter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /* ---------------- 客户端二次筛选（「包含待办」） ---------------- */
  const rows = useMemo(() => {
    if (filter === 'hasAction') return list.filter((m) => m.actionCount > 0);
    return list;
  }, [list, filter]);

  /* ---------------- 虚拟滚动 ---------------- */
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CARD_HEIGHT,
    overscan: 6,
  });

  /* ---------------- 操作 ---------------- */
  const handleDelete = useCallback(
    async (m: MeetingSummary) => {
      const ok = await requestConfirm({
        title: '删除后不可恢复，确定删除这场会议吗',
        body: `${m.meeting.title}（${fmtDateTime(m.meeting.startedAt)}，${m.meeting.utteranceCount} 条发言）`,
        confirmText: '删除',
        danger: true,
      });
      if (!ok) return;
      await getRepo().deleteMeeting(m.meeting.id);
      toast.success('已删除');
      await reload();
    },
    [reload, requestConfirm, toast],
  );

  /* ---------------- 渲染 ---------------- */
  const isEmpty = !loading && rows.length === 0;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col p-4">
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
        <TextField
          inputRef={inputRef}
          size="small"
          fullWidth
          placeholder="搜索会议标题、参会人或发言内容（Ctrl/Cmd + K）"
          value={keyword}
          onChange={(e) => onSearchChange(e.target.value)}
          InputProps={{ startAdornment: <SearchIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} /> }}
        />
        <ToggleButtonGroup
          size="small"
          exclusive
          value={filter}
          onChange={(_, v: FilterMode | null) => v && setFilter(v)}
        >
          <ToggleButton value="all">全部</ToggleButton>
          <ToggleButton value="hasAction">包含待办</ToggleButton>
          <ToggleButton value="openAction">仅未完成</ToggleButton>
        </ToggleButtonGroup>
        <Box sx={{ flex: 1 }} />
        <Button
          variant="contained"
          size="small"
          startIcon={<EditNoteIcon />}
          onClick={() => navigate('/quick')}
        >
          新建速记会话
        </Button>
      </Stack>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <CircularProgress size={22} />
          <span className="ml-2 text-sm text-slate-500">载入中…</span>
        </div>
      ) : null}

      {isEmpty ? (
        <EmptyState
          title={appliedKeyword ? '没有匹配的会议' : '还没有会议记录'}
          description={
            appliedKeyword
              ? `没有找到包含「${appliedKeyword}」的会议，换个关键词试试`
              : '开始一场会议后，纪要会自动出现在这里，支持搜索与导出'
          }
          actionText={appliedKeyword ? '清空搜索' : '开始一场会议'}
          onAction={() => {
            if (appliedKeyword) {
              setKeyword('');
              setAppliedKeyword('');
            } else {
              navigate('/live/new');
            }
          }}
        />
      ) : null}

      {rows.length > 0 ? (
        <>
          <Typography variant="caption" color="text.secondary" sx={{ mb: 1 }}>
            共 {rows.length} 场会议
          </Typography>
          <div ref={scrollRef} className="scroll-thin h-[calc(100vh-260px)] overflow-auto">
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
              {virtualizer.getVirtualItems().map((vi) => {
                const m = rows[vi.index];
                return (
                  <div
                    key={m.meeting.id}
                    data-index={vi.index}
                    ref={virtualizer.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)`, paddingBottom: 12 }}
                  >
                    <Card variant="outlined" sx={{ cursor: 'pointer', '&:hover': { borderColor: 'primary.light' } }}>
                      <CardContent>
                        <Stack direction="row" alignItems="flex-start" spacing={1}>
                          <div className="min-w-0 flex-1" onClick={() => navigate(`/review/${m.meeting.id}`)}>
                            <Typography variant="subtitle1" sx={{ fontWeight: 600 }} noWrap>
                              {m.meeting.title}
                            </Typography>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                              <span>{fmtDateTime(m.meeting.startedAt)}</span>
                              <span>·</span>
                              <span>{fmtDurCN(m.meeting.durationMs || 0)}</span>
                              <span>·</span>
                              <span>{m.meeting.utteranceCount} 条发言</span>
                              {m.meeting.status !== 'ended' ? <Chip size="small" color="warning" label="未结束" /> : null}
                            </div>
                          </div>
                          <Stack direction="row" spacing={0.5}>
                            <Tooltip title="打开纪要" arrow>
                              <IconButton size="small" color="primary" onClick={() => navigate(`/review/${m.meeting.id}`)}>
                                <OpenInNewIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            <CardExportMenu meetingId={m.meeting.id} />
                            <Tooltip title="删除" arrow>
                              <IconButton size="small" color="error" onClick={() => void handleDelete(m)}>
                                <DeleteOutlineIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </Stack>
                        </Stack>

                        <div className="mt-2 flex flex-wrap items-center gap-1">
                          {m.participants.slice(0, 6).map((p) => (
                            <Chip
                              key={p.id}
                              size="small"
                              variant="outlined"
                              avatar={<SpeakerAvatar name={p.name} colorIndex={p.colorIndex} size={20} />}
                              label={p.name}
                            />
                          ))}
                        </div>

                        <Divider sx={{ my: 1 }} />

                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                          <Chip size="small" label={`议题 ${m.topicCount}`} variant="outlined" />
                          <Chip size="small" label={`决议 ${m.decisionCount}`} variant="outlined" />
                          <Chip
                            size="small"
                            color={m.openActionCount > 0 ? 'warning' : 'default'}
                            label={`待办 ${m.openActionCount}/${m.actionCount}`}
                          />
                          {m.hitSnippet ? (
                            <span
                              className="min-w-0 flex-1 truncate text-xs text-slate-500"
                              // hitSnippet 由 highlightSnippet() 生成：内容已 escapeHtml，仅 <mark> 为可信标签
                              dangerouslySetInnerHTML={{ __html: m.hitSnippet }}
                            />
                          ) : null}
                        </Stack>
                      </CardContent>
                    </Card>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
