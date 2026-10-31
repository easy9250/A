import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import MenuIcon from '@mui/icons-material/Menu';
import UndoIcon from '@mui/icons-material/Undo';
import { useMeetingStore } from '@/stores/useMeetingStore';
import { toast } from '@/stores/useUiStore';
import { getRepo } from '@/core/repo';
import { mediaController } from '@/core/audio/MediaController';
import { structureMeeting } from '@/core/struct';
import ExportMenu from '@/components/common/ExportMenu';
import { EmptyState, SpeakerAvatar } from '@/components/common/UiKit';
import TopicSection from '@/components/review/TopicSection';
import { ActionPanel, DecisionPanel, playFromUtterance } from '@/components/review/OutcomePanel';
import { debounce, fmtDateTime, fmtDurCN, hhmmss } from '@/lib/utils';
import type { MeetingSnapshot } from '@/types/models';
import { UNKNOWN_SPEAKER_ID } from '@/types/models';

/** 编辑保存防抖（P0-14①） */
const SAVE_DEBOUNCE_MS = 800;

/** 大纲导航项 */
const OUTLINE = [
  { key: 'info', label: '会议信息' },
  { key: 'topics', label: '议题' },
  { key: 'decisions', label: '决议' },
  { key: 'actions', label: '待办' },
  { key: 'transcript', label: '全部发言' },
] as const;

type OutlineKey = (typeof OUTLINE)[number]['key'];

/** 单行发言：只订阅自己的那条，避免整表重渲染 */
function TranscriptLine(props: { id: string; name: string; colorIndex: number; highlighted: boolean }): JSX.Element {
  const u = useMeetingStore((s) => s.uttMap[props.id]);
  if (!u) return <div />;
  return (
    <div
      className="flex gap-2 px-2 py-1 text-sm"
      style={{
        background: props.highlighted ? 'rgba(37,99,235,0.10)' : 'transparent',
        borderRadius: 6,
      }}
    >
      <span className="mt-0.5 font-mono text-xs text-slate-400">[{hhmmss(u.startMs)}]</span>
      <span className="mt-0.5 shrink-0">
        <SpeakerAvatar name={props.name} colorIndex={props.colorIndex} size={22} />
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
        <b className="mr-1 text-slate-600">{props.name}</b>
        {u.text}
      </span>
    </div>
  );
}
const MemoLine = memo(TranscriptLine);

/**
 * 纪要编辑页（页面 B）。
 * 左：大纲导航（<1024px 折叠为抽屉）；右：编辑主区。
 */
export default function ReviewPage(): JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const meeting = useMeetingStore((s) => s.meeting);
  const participants = useMeetingStore((s) => s.participants);
  const utteranceIds = useMeetingStore((s) => s.utteranceIds);
  const uttMap = useMeetingStore((s) => s.uttMap);
  const topics = useMeetingStore((s) => s.topics);
  const decisions = useMeetingStore((s) => s.decisions);
  const actionItems = useMeetingStore((s) => s.actionItems);
  const undoDepth = useMeetingStore((s) => s.undoDepth);
  const applyStructResult = useMeetingStore((s) => s.applyStructResult);

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [structuring, setStructuring] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const sectionRefs = useRef<Record<OutlineKey, HTMLDivElement | null>>({
    info: null,
    topics: null,
    decisions: null,
    actions: null,
    transcript: null,
  });

  /* ---------------- 绑定播放器：溯源跳转时按相对毫秒起播录音 ---------------- */
  useEffect(() => {
    const el = audioRef.current;
    mediaController.attachPlayer(el);
    // 带身份校验地解绑：避免路由切换时误清别人刚挂上的 <audio>
    return () => mediaController.detachPlayer(el);
  }, []);

  /* ---------------- 载入会议 ---------------- */
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const store = useMeetingStore.getState();
    if (store.meeting?.id === id) {
      setTitleDraft(store.meeting.title);
      setLoading(false);
      return () => {
        alive = false;
      };
    }
    void getRepo()
      .loadSnapshot(id)
      .then((snap: MeetingSnapshot | null) => {
        if (!alive) return;
        if (!snap) {
          setNotFound(true);
          setLoading(false);
          return;
        }
        useMeetingStore.getState().loadSnapshot(snap);
        setTitleDraft(snap.meeting.title);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  /* ---------------- 800ms 防抖保存（会中 5s 自动落盘由 App 负责，不重复） ---------------- */
  const saveNow = useCallback(async () => {
    const st = useMeetingStore.getState();
    const snap = st.getSnapshot();
    if (!snap || !st.dirty) return;
    await getRepo().saveSnapshot(snap);
    st.markSaved();
  }, []);

  const debouncedSave = useMemo(() => debounce(() => void saveNow(), SAVE_DEBOUNCE_MS), [saveNow]);

  useEffect(() => {
    if (loading || notFound) return;
    debouncedSave();
  }, [topics, decisions, actionItems, meeting?.title, loading, notFound, debouncedSave]);

  useEffect(() => () => debouncedSave.cancel(), [debouncedSave]);

  /* ---------------- 结构化整理 ---------------- */
  const runStructure = useCallback(async (): Promise<void> => {
    const st = useMeetingStore.getState();
    const snap = st.getSnapshot();
    if (!snap) return;
    setStructuring(true);
    try {
      const res = await structureMeeting(
        { meeting: snap.meeting, participants: snap.participants, utterances: snap.utterances },
        (partial) => {
          // 渐进渲染：AI 分片返回时先显示已有部分
          if (partial.topics || partial.decisions || partial.actionItems) {
            useMeetingStore.getState().applyStructResult({
              topics: partial.topics ?? [],
              decisions: partial.decisions ?? [],
              actionItems: partial.actionItems ?? [],
            });
          }
        },
      );
      applyStructResult({ topics: res.topics, decisions: res.decisions, actionItems: res.actionItems });
      toast.success(res.origin === 'ai' ? 'AI 整理完成' : '本地规则整理完成');
    } catch {
      toast.error('整理失败，请稍后重试');
    } finally {
      setStructuring(false);
    }
  }, [applyStructResult]);

  /* ---------------- 首次进入若无结构化产出，自动跑一次 ---------------- */
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (loading || notFound || autoRanRef.current) return;
    autoRanRef.current = true;
    const st = useMeetingStore.getState();
    if (st.topics.length > 0 || st.decisions.length > 0 || st.actionItems.length > 0) return;
    if (st.utteranceIds.length === 0) return;
    void runStructure();
  }, [loading, notFound, runStructure]);

  /* ---------------- 虚拟滚动（发言记录） ---------------- */
  const virtualizer = useVirtualizer({
    count: utteranceIds.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    overscan: 8,
  });

  /* ---------------- 溯源跳转 ---------------- */
  const handleLocate = useCallback(
    (utteranceId: string) => {
      const idx = utteranceIds.indexOf(utteranceId);
      if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'center' });
      setHighlightId(utteranceId);
      sectionRefs.current.transcript?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      window.setTimeout(() => setHighlightId(null), 2600);
      const u = uttMap[utteranceId];
      if (u && meeting) void playFromUtterance(meeting.id, u);
    },
    [meeting, utteranceIds, uttMap, virtualizer],
  );

  const scrollTo = useCallback((key: OutlineKey) => {
    setDrawerOpen(false);
    sectionRefs.current[key]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  /* ---------------- 编辑操作 ---------------- */
  const store = useMeetingStore;
  const utterances = useMemo(() => utteranceIds.map((i) => uttMap[i]).filter(Boolean), [utteranceIds, uttMap]);
  const realParticipants = useMemo(() => participants.filter((p) => p.id !== UNKNOWN_SPEAKER_ID), [participants]);
  const speakerOf = useCallback(
    (sid: string | null) => {
      const name = participants.find((p) => p.id === sid)?.name ?? '未知发言人';
      const colorIndex = participants.find((p) => p.id === sid)?.colorIndex ?? 7;
      return { name, colorIndex };
    },
    [participants],
  );

  const getSnapshot = useCallback(() => useMeetingStore.getState().getSnapshot(), []);

  const handleTitleBlur = useCallback(() => {
    const next = titleDraft.trim();
    const st = useMeetingStore.getState();
    if (!st.meeting || !next || next === st.meeting.title) {
      setTitleDraft(st.meeting?.title ?? '');
      return;
    }
    st.patchMeeting({ title: next });
  }, [titleDraft]);

  const handleUndo = useCallback(() => {
    const ok = useMeetingStore.getState().undo();
    if (!ok) toast.info('没有可撤销的操作');
  }, []);

  /* ---------------- 渲染 ---------------- */
  const outline = (
    <List dense>
      {OUTLINE.map((o) => (
        <ListItemButton key={o.key} onClick={() => scrollTo(o.key)}>
          <ListItemText primary={o.label} />
        </ListItemButton>
      ))}
    </List>
  );

  if (notFound) {
    return (
      <EmptyState
        title="会议不存在或已被删除"
        description="它可能已在历史页被删除，或来自另一台设备的数据"
        actionText="返回历史"
        onAction={() => navigate('/')}
      />
    );
  }

  if (loading || !meeting) {
    return (
      <div className="flex flex-1 items-center justify-center p-10">
        <CircularProgress size={24} />
        <span className="ml-2 text-sm text-slate-500">正在载入会议…</span>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* 左侧大纲：≥1024px 常驻 */}
      <aside className="hidden w-52 shrink-0 border-r border-slate-200 bg-white p-2 lg:block">
        <Typography variant="caption" color="text.secondary" sx={{ px: 1 }}>
          大纲
        </Typography>
        {outline}
      </aside>
      <Drawer anchor="left" open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <Box sx={{ width: 200, p: 1 }} role="presentation">
          {outline}
        </Box>
      </Drawer>

      {/* 右侧主区 */}
      <div className="min-w-0 flex-1 overflow-auto scroll-thin">
        <div className="mx-auto max-w-4xl p-4">
          {/* 顶部操作条 */}
          <Stack direction="row" alignItems="center" spacing={1} className="no-print">
            <IconButton className="lg:hidden" size="small" onClick={() => setDrawerOpen(true)}>
              <MenuIcon />
            </IconButton>
            <Tooltip title="返回历史" arrow>
              <IconButton size="small" onClick={() => navigate('/')}>
                <ArrowBackIcon />
              </IconButton>
            </Tooltip>
            <div style={{ flex: 1 }} />
            <Tooltip title={`撤销（${undoDepth} 步可撤销）`} arrow>
              <span>
                <IconButton size="small" onClick={handleUndo} disabled={undoDepth === 0}>
                  <UndoIcon />
                </IconButton>
              </span>
            </Tooltip>
            <Button
              size="small"
              variant="outlined"
              startIcon={structuring ? <CircularProgress size={14} /> : <AutoAwesomeIcon />}
              disabled={structuring}
              onClick={() => void runStructure()}
            >
              {structuring ? '整理中…' : 'AI 重新整理'}
            </Button>
            <ExportMenu getSnapshot={getSnapshot} />
          </Stack>

          {/* 会议信息 */}
          <div ref={(el) => { sectionRefs.current.info = el; }} className="mt-2">
            <Card variant="outlined">
              <CardContent>
                <TextField
                  fullWidth
                  variant="standard"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={handleTitleBlur}
                  inputProps={{ sx: { fontSize: 20, fontWeight: 600 } }}
                />
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span>{fmtDateTime(meeting.startedAt)}</span>
                  <span>·</span>
                  <span>时长 {fmtDurCN(meeting.durationMs || 0)}</span>
                  <span>·</span>
                  <span>{utteranceIds.length} 条发言</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  {realParticipants.length === 0 ? (
                    <Chip size="small" variant="outlined" label="未记录参会人" />
                  ) : (
                    realParticipants.map((p) => (
                      <Chip
                        key={p.id}
                        size="small"
                        variant="outlined"
                        avatar={<SpeakerAvatar name={p.name} colorIndex={p.colorIndex} size={20} />}
                        label={p.name}
                      />
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* 议题 */}
          <div ref={(el) => { sectionRefs.current.topics = el; }} className="mt-4">
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                议题
              </Typography>
              <Chip size="small" label={topics.length} />
              <Button
                size="small"
                onClick={() =>
                  store.getState().addTopic({ title: '新议题', bullets: [], origin: 'manual' })
                }
              >
                + 新增议题
              </Button>
            </Stack>
            {topics.length === 0 ? (
              <Card variant="outlined">
                <CardContent>
                  <Typography variant="body2" color="text.secondary">
                    暂无议题，点击右上角「AI 重新整理」自动生成，或手动新增
                  </Typography>
                </CardContent>
              </Card>
            ) : (
              <Stack spacing={1.5}>
                {topics.map((t, i) => (
                  <TopicSection
                    key={t.id}
                    topic={t}
                    index={i}
                    total={topics.length}
                    utterances={utterances}
                    onUpdate={(tid, patch) => store.getState().updateTopic(tid, patch)}
                    onRemove={(tid) => store.getState().removeTopic(tid)}
                    onMove={(tid, dir) => store.getState().moveTopic(tid, dir)}
                    onLocate={handleLocate}
                  />
                ))}
              </Stack>
            )}
          </div>

          {/* 决议 */}
          <div ref={(el) => { sectionRefs.current.decisions = el; }} className="mt-4">
            <DecisionPanel
              meetingId={meeting.id}
              decisions={decisions}
              utterances={utterances}
              onUpdate={(did, patch) => store.getState().updateDecision(did, patch)}
              onRemove={(did) => store.getState().removeDecision(did)}
              onAdd={() =>
                store.getState().addDecision({
                  content: '新决议',
                  sourceUtteranceIds: [],
                  confirmed: false,
                  origin: 'manual',
                })
              }
              onLocate={handleLocate}
            />
          </div>

          {/* 待办 */}
          <div ref={(el) => { sectionRefs.current.actions = el; }} className="mt-4">
            <ActionPanel
              meetingId={meeting.id}
              actionItems={actionItems}
              utterances={utterances}
              participants={participants}
              getSnapshot={getSnapshot}
              onUpdate={(aid, patch) => store.getState().updateActionItem(aid, patch)}
              onRemove={(aid) => store.getState().removeActionItem(aid)}
              onAdd={() =>
                store.getState().addActionItem({
                  content: '新待办',
                  assigneeId: null,
                  dueDate: null,
                  priority: 'P2',
                  status: 'todo',
                  sourceUtteranceIds: [],
                  origin: 'manual',
                })
              }
              onLocate={handleLocate}
            />
          </div>

          {/* 全部发言（虚拟滚动） */}
          <div ref={(el) => { sectionRefs.current.transcript = el; }} className="mt-4">
            <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
              全部发言（{utteranceIds.length}）
            </Typography>
            <Card variant="outlined">
              <CardContent>
                {utteranceIds.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    暂无发言记录
                  </Typography>
                ) : (
                  <div ref={scrollRef} className="scroll-thin h-[520px] overflow-auto">
                    <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
                      {virtualizer.getVirtualItems().map((vi) => {
                        const uid = utteranceIds[vi.index];
                        const u = uttMap[uid];
                        const sp = speakerOf(u?.speakerId ?? null);
                        return (
                          <div
                            key={uid}
                            data-index={vi.index}
                            ref={virtualizer.measureElement}
                            style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                          >
                            <MemoLine id={uid} name={sp.name} colorIndex={sp.colorIndex} highlighted={highlightId === uid} />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <Divider sx={{ my: 3 }} />
          <Typography variant="caption" color="text.secondary">
            编辑后 800ms 自动保存；撤销栈最多 30 步（Ctrl/Cmd + Z）
          </Typography>

          {/*
            录音播放器：溯源 ↗ 点击后按发言时间码起播。
            ★ 这里必须用持久化的 meeting.hasAudio，不能用 mediaController.hasAudioSource()：
            后者是「当前会话内存态」（audioBlob / chunks），会中结束流程 destroy() 后已清空，
            跨会话打开历史会议时恒为 false，用它控制 controls 会把有录音的会议播放器藏掉。
          */}
          {meeting.hasAudio ? (
            <audio ref={audioRef} controls preload="metadata" className="mt-2 w-full" />
          ) : (
            <audio ref={audioRef} hidden preload="none" />
          )}
        </div>
      </div>
    </div>
  );
}
