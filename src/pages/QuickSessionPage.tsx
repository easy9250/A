/**
 * 速记会话页（新增交互）：
 *   1) 进入：填写标题 → 点击「开始会话」
 *   2) 记录中：左栏实时语音转写 + 右栏文字笔记（两者并行，共用时间轴）
 *   3) 结束：点击「结束会话」→ 系统自动整合笔记与录音 → 生成结构化总结 + 关键统计
 *
 * 复用：useQuickSession（语音/录音/整合编排）、useQuickSessionStore（状态）、
 *      ExportMenu（四格式导出）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import IconButton from '@mui/material/IconButton';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { mediaController } from '@/core/audio/MediaController';
import EditNoteIcon from '@mui/icons-material/EditNote';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import StopIcon from '@mui/icons-material/Stop';
import MicIcon from '@mui/icons-material/Mic';
import ScheduleIcon from '@mui/icons-material/Schedule';
import PlaylistAddCheckIcon from '@mui/icons-material/PlaylistAddCheck';
import LightbulbIcon from '@mui/icons-material/Lightbulb';
import GavelIcon from '@mui/icons-material/Gavel';
import AssignmentIcon from '@mui/icons-material/Assignment';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import HistoryIcon from '@mui/icons-material/History';
import { useQuickSession } from '@/features/quick/useQuickSession';
import { quickElapsedMs, useQuickSessionStore } from '@/features/quick/store';
import { NOTE_SPEAKER_ID } from '@/features/quick/integrate';
import type { SessionEntry } from '@/features/quick/types';
import ExportMenu from '@/components/common/ExportMenu';
import { fmtDateTime, fmtDurCN, hhmmss, mmss } from '@/lib/utils';

/* ==================== 小卡片：统计指标 ==================== */
function StatCard(props: { icon: React.ReactNode; label: string; value: string; accent?: string }): JSX.Element {
  const { icon, label, value, accent } = props;
  return (
    <Card variant="outlined" sx={{ flex: '1 1 0', minWidth: 120 }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Box sx={{ color: accent ?? 'primary.main', display: 'flex' }}>{icon}</Box>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 700, lineHeight: 1.1 }}>
              {value}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {label}
            </Typography>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

/* ==================== 单条会话条目（转写 / 笔记） ==================== */
function EntryRow(props: { entry: SessionEntry }): JSX.Element {
  const { entry } = props;
  const isNote = entry.kind === 'note';
  return (
    <Box sx={{ display: 'flex', gap: 1, py: 0.5 }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', width: 52, flexShrink: 0, pt: 0.3, fontVariantNumeric: 'tabular-nums' }}>
        {mmss(entry.relMs)}
      </Typography>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mb: 0.25 }}>
          {isNote ? (
            <EditNoteIcon sx={{ fontSize: 15, color: '#009E73' }} />
          ) : (
            <RecordVoiceOverIcon sx={{ fontSize: 15, color: 'text.secondary' }} />
          )}
          <Typography variant="caption" sx={{ color: isNote ? '#009E73' : 'text.secondary', fontWeight: 600 }}>
            {isNote ? '笔记' : '转写'}
          </Typography>
        </Stack>
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {entry.text}
        </Typography>
      </Box>
    </Box>
  );
}

/* ==================== 结果页：我的笔记 ==================== */
function NotesPanel(props: { snapshotNotes: { relMs: number; text: string }[] }): JSX.Element {
  const { snapshotNotes } = props;
  if (snapshotNotes.length === 0) {
    return <Typography variant="body2" color="text.secondary">本次会话没有文字笔记。</Typography>;
  }
  return (
    <Stack spacing={0.5}>
      {snapshotNotes.map((n, i) => (
        <Box key={i} sx={{ display: 'flex', gap: 1 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', width: 52, flexShrink: 0, pt: 0.3, fontVariantNumeric: 'tabular-nums' }}>
            {mmss(n.relMs)}
          </Typography>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {n.text}
          </Typography>
        </Box>
      ))}
    </Stack>
  );
}

/* ==================== 主页面 ==================== */
export default function QuickSessionPage(): JSX.Element {
  const navigate = useNavigate();
  const phase = useQuickSessionStore((s) => s.phase);
  const storeTitle = useQuickSessionStore((s) => s.title);
  const startedAt = useQuickSessionStore((s) => s.startedAt);
  const endedAt = useQuickSessionStore((s) => s.endedAt);
  const entries = useQuickSessionStore((s) => s.entries);
  const interim = useQuickSessionStore((s) => s.interim);
  const label = useQuickSessionStore((s) => s.label);
  const banner = useQuickSessionStore((s) => s.banner);
  const result = useQuickSessionStore((s) => s.result);
  const clockVersion = useQuickSessionStore((s) => s.clockVersion);

  const start = useQuickSessionStore((s) => s.start);
  const updateNote = useQuickSessionStore((s) => s.updateNote);
  const removeNote = useQuickSessionStore((s) => s.removeNote);
  const reset = useQuickSessionStore((s) => s.reset);

  const api = useQuickSession();

  const [titleInput, setTitleInput] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [finishing, setFinishing] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  /* 进入 active 时启动语音 */
  useEffect(() => {
    if (phase === 'active') void api.boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  /* 计时器：active 时每秒 tick，驱动时长展示 */
  useEffect(() => {
    if (phase !== 'active') return;
    const id = window.setInterval(() => useQuickSessionStore.getState().tick(), 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  /* 音量电平轮询 */
  const [levelBar, setLevelBar] = useState(0);
  useEffect(() => {
    if (phase !== 'active') return;
    const id = window.setInterval(() => setLevelBar(api.readLevel()), 120);
    return () => window.clearInterval(id);
  }, [phase, api]);

  /* 试音电平轮询（idle 测试时） */
  const [testLevel, setTestLevel] = useState(0);
  useEffect(() => {
    if (!api.testing) {
      setTestLevel(0);
      return;
    }
    const id = window.setInterval(() => setTestLevel(api.readLevel()), 120);
    return () => window.clearInterval(id);
  }, [api.testing, api]);

  /* 离开速记页时释放麦克风 */
  useEffect(() => () => {
    mediaController.destroy();
  }, []);

  /* 转写自动滚到底 */
  useEffect(() => {
    if (transcriptEndRef.current) transcriptEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries, interim, phase]);

  const elapsed = startedAt == null ? 0 : Math.max(0, (endedAt ?? Date.now()) - startedAt);

  const sortedEntries = useMemo(
    () => [...entries].sort((a, b) => a.relMs - b.relMs || a.createdAt - b.createdAt),
    [entries],
  );
  const noteEntries = useMemo(() => entries.filter((e) => e.kind === 'note'), [entries]);

  const handleStart = useCallback(() => {
    start(titleInput.trim() || undefined);
  }, [start, titleInput]);

  const handleAddNote = useCallback(() => {
    const text = noteDraft.trim();
    if (!text) return;
    api.pushNote(text);
    setNoteDraft('');
  }, [api, noteDraft]);

  const handleFinish = useCallback(async () => {
    setFinishing(true);
    try {
      await api.finish();
    } finally {
      setFinishing(false);
    }
  }, [api]);

  const handleReset = useCallback(() => {
    reset();
    setTitleInput('');
    setNoteDraft('');
    setEditId(null);
  }, [reset]);

  const getSnapshot = useCallback(() => result?.snapshot ?? null, [result]);

  /* -------------------- 1) 未开始：入口 -------------------- */
  if (phase === 'idle') {
    return (
      <Box className="mx-auto flex w-full max-w-2xl flex-col p-4">
        <Card variant="outlined" sx={{ p: 3 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
            <RecordVoiceOverIcon color="primary" />
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              速记会话
            </Typography>
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            进入后即可<strong>边听边记</strong>：系统实时转写语音，你同时用文字笔记记录重点。结束时一键整合，自动生成结构化总结与关键统计。
          </Typography>
          <TextField
            fullWidth
            size="small"
            label="会话标题（可选）"
            placeholder="例如：项目周会 / 客户访谈"
            value={titleInput}
            onChange={(e) => setTitleInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleStart();
            }}
            sx={{ mb: 2 }}
          />
          <Button fullWidth variant="contained" size="large" startIcon={<MicIcon />} onClick={handleStart}>
            开始会话
          </Button>

          <Divider sx={{ my: 2 }} />
          <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
            麦克风测试（可选）
          </Typography>
          {!api.testing && !api.levelError && (
            <Button variant="outlined" size="small" startIcon={<GraphicEqIcon />} onClick={() => void api.testMic()}>
              测试麦克风
            </Button>
          )}
          {api.testing && (
            <Stack spacing={1}>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  对着麦克风说话，下方音量条应有反应：
                </Typography>
                <Box sx={{ mt: 0.5, width: '100%', height: 12, borderRadius: 6, bgcolor: 'rgba(0,0,0,.08)', overflow: 'hidden' }}>
                  <Box
                    sx={{
                      width: `${Math.round(testLevel * 100)}%`,
                      height: '100%',
                      bgcolor: testLevel > 0.05 ? '#009E73' : 'transparent',
                      transition: 'width .1s linear',
                    }}
                  />
                </Box>
              </Box>
              <FormControl size="small" fullWidth>
                <InputLabel id="mic-sel-label">输入设备</InputLabel>
                <Select
                  labelId="mic-sel-label"
                  label="输入设备"
                  value={api.deviceId}
                  onChange={(e) => void api.switchDevice(String(e.target.value))}
                >
                  <MenuItem value="">系统默认</MenuItem>
                  {api.devices.map((d) => (
                    <MenuItem key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Button variant="text" size="small" color="inherit" onClick={api.stopTest}>
                停止测试
              </Button>
            </Stack>
          )}
          {api.levelError && (
            <Alert severity="warning" sx={{ mt: 1 }}>
              {api.levelError}
            </Alert>
          )}

          <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>
            提示：实时识别需要 Chrome / Edge 与麦克风权限；无麦克风或受限环境下会自动降级为「仅笔记」，功能依然可用。
          </Typography>
        </Card>
      </Box>
    );
  }

  /* -------------------- 3) 已结束：结果 -------------------- */
  if (phase === 'done' && result) {
    const m = result.snapshot.meeting;
    const s = result.stats;
    const notes = result.snapshot.utterances
      .filter((u) => u.speakerId === NOTE_SPEAKER_ID)
      .map((u) => ({ relMs: u.startMs, text: u.text }));
    return (
      <Box className="mx-auto flex w-full max-w-4xl flex-col p-4">
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              {m.title}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {fmtDateTime(m.startedAt)} · 时长 {fmtDurCN(s.durationMs)} · {s.entryCount} 条记录
            </Typography>
          </Box>
          <Box sx={{ flex: 1 }} />
          <ExportMenu getSnapshot={getSnapshot} size="medium" />
          <Button variant="outlined" startIcon={<HistoryIcon />} onClick={() => navigate('/')}>
            返回历史
          </Button>
          <Button variant="contained" startIcon={<RestartAltIcon />} onClick={handleReset}>
            新建会话
          </Button>
        </Stack>

        {/* 关键统计 */}
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(4, 1fr)', md: 'repeat(7, 1fr)' }, gap: 1.5, mb: 3 }}>
          <StatCard icon={<ScheduleIcon />} label="会话时长" value={fmtDurCN(s.durationMs)} accent="#2563EB" />
          <StatCard icon={<EditNoteIcon />} label="笔记条目" value={String(s.noteCount)} accent="#009E73" />
          <StatCard icon={<RecordVoiceOverIcon />} label="语音段数" value={String(s.voiceSegments)} accent="#7D7D7D" />
          <StatCard icon={<PlaylistAddCheckIcon />} label="总记录" value={String(s.entryCount)} accent="#1E3A8A" />
          <StatCard icon={<LightbulbIcon />} label="议题" value={String(s.topicCount)} accent="#E69F00" />
          <StatCard icon={<GavelIcon />} label="决议" value={String(s.decisionCount)} accent="#0072B2" />
          <StatCard icon={<AssignmentIcon />} label="待办" value={`${s.openActionCount}/${s.actionCount}`} accent="#D55E00" />
        </Box>

        {/* 结构化总结 */}
        <Card variant="outlined" sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
              结构化总结
            </Typography>
            <Stack spacing={2}>
              <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>议题</Typography>
                {result.snapshot.topics.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">（无）</Typography>
                ) : (
                  result.snapshot.topics.map((t, i) => (
                    <Box key={t.id ?? i} sx={{ mb: 1 }}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>{i + 1}. {t.title}</Typography>
                      {t.bullets?.map((b, j) => (
                        <Typography key={j} variant="body2" color="text.secondary" sx={{ pl: 2 }}>· {b}</Typography>
                      ))}
                    </Box>
                  ))
                )}
              </Box>
              <Divider />
              <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>决议</Typography>
                {result.snapshot.decisions.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">（无）</Typography>
                ) : (
                  result.snapshot.decisions.map((d, i) => (
                    <Typography key={d.id ?? i} variant="body2" sx={{ pl: 1 }}>{i + 1}. {d.content}</Typography>
                  ))
                )}
              </Box>
              <Divider />
              <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>待办事项</Typography>
                {result.snapshot.actionItems.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">（无）</Typography>
                ) : (
                  result.snapshot.actionItems.map((a, i) => (
                    <Box key={a.id ?? i} sx={{ display: 'flex', gap: 1, alignItems: 'center', py: 0.25 }}>
                      <Chip size="small" label={a.priority} color={a.priority === 'P0' ? 'error' : a.priority === 'P1' ? 'warning' : 'default'} />
                      <Typography variant="body2" sx={{ flex: 1 }}>{a.content}</Typography>
                      {a.status === 'done' ? <Chip size="small" label="已完成" color="success" /> : null}
                    </Box>
                  ))
                )}
              </Box>
            </Stack>
          </CardContent>
        </Card>

        {/* 我的笔记（原始文字笔记，独立于转写） */}
        <Card variant="outlined">
          <CardContent>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
              <EditNoteIcon color="success" />
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>我的笔记（{notes.length}）</Typography>
            </Stack>
            <NotesPanel snapshotNotes={notes} />
          </CardContent>
        </Card>
      </Box>
    );
  }

  /* -------------------- 2) 记录中：双栏并行 -------------------- */
  return (
    <Box className="mx-auto flex w-full max-w-5xl flex-col p-3">
      {/* 顶部状态条 */}
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
        <Chip
          size="small"
          color="error"
          icon={<GraphicEqIcon sx={{ fontSize: 14 }} />}
          label={mmss(elapsed)}
          sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}
        />
        <Chip size="small" color={label.includes('本地') ? 'default' : 'success'} label={label} />
        <Tooltip title="实时音量">
          <Box sx={{ width: 90, height: 8, borderRadius: 4, bgcolor: 'rgba(0,0,0,.08)', overflow: 'hidden' }}>
            <Box sx={{ width: `${Math.round(levelBar * 100)}%`, height: '100%', bgcolor: levelBar > 0.05 ? '#009E73' : 'transparent', transition: 'width .1s linear' }} />
          </Box>
        </Tooltip>
        {api.devices.length > 0 && (
          <FormControl size="small" sx={{ minWidth: 150 }}>
            <Select
              displayEmpty
              value={api.deviceId}
              onChange={(e) => void api.switchDevice(String(e.target.value))}
            >
              <MenuItem value="">系统默认</MenuItem>
              {api.devices.map((d) => (
                <MenuItem key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}
        <Box sx={{ flex: 1 }} />
        <Button
          variant="contained"
          color="error"
          startIcon={finishing ? <CircularProgress size={16} color="inherit" /> : <StopIcon />}
          disabled={finishing}
          onClick={handleFinish}
        >
          {finishing ? '整合中…' : '结束会话'}
        </Button>
      </Stack>

      {banner ? (
        <Alert severity={banner.kind} sx={{ mb: 2 }} onClose={() => useQuickSessionStore.getState().setBanner(null)}>
          {banner.msg}
        </Alert>
      ) : null}

      {/* 双栏：左转写 / 右笔记 */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2, minHeight: '60vh' }}>
        {/* 左：实时转写 */}
        <Card variant="outlined" sx={{ display: 'flex', flexDirection: 'column', minHeight: 420 }}>
          <CardContent sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
              <RecordVoiceOverIcon color="primary" />
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>实时转写</Typography>
            </Stack>
            <Box sx={{ flex: 1, overflowY: 'auto', pr: 0.5 }}>
              {sortedEntries.length === 0 && !interim ? (
                <Typography variant="body2" color="text.secondary">开始说话，转写会实时出现在这里…</Typography>
              ) : (
                sortedEntries.map((e) => <EntryRow key={e.id} entry={e} />)
              )}
              {interim ? (
                <Box sx={{ display: 'flex', gap: 1, py: 0.5, opacity: 0.7 }}>
                  <Typography variant="caption" sx={{ width: 52, flexShrink: 0, color: 'text.secondary' }}>{mmss(elapsed)}</Typography>
                  <Typography variant="body2" sx={{ fontStyle: 'italic' }}>{interim}</Typography>
                </Box>
              ) : null}
              <div ref={transcriptEndRef} />
            </Box>
          </CardContent>
        </Card>

        {/* 右：文字笔记 */}
        <Card variant="outlined" sx={{ display: 'flex', flexDirection: 'column', minHeight: 420 }}>
          <CardContent sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
              <EditNoteIcon color="success" />
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>文字笔记</Typography>
            </Stack>
            <TextField
              fullWidth
              multiline
              minRows={3}
              maxRows={6}
              size="small"
              placeholder="随时记录重点、灵感或待确认事项…（Ctrl/⌘ + Enter 快速添加）"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault();
                  handleAddNote();
                }
              }}
              sx={{ mb: 1 }}
            />
            <Button fullWidth variant="contained" color="success" startIcon={<EditNoteIcon />} onClick={handleAddNote} sx={{ mb: 1.5 }}>
              添加笔记
            </Button>
            <Box sx={{ flex: 1, overflowY: 'auto' }}>
              {noteEntries.length === 0 ? (
                <Typography variant="body2" color="text.secondary">还没有笔记。边听边记，重点不遗漏。</Typography>
              ) : (
                <Stack spacing={0.75}>
                  {noteEntries.map((e) => (
                    <Card key={e.id} variant="outlined" sx={{ bgcolor: '#F0FBF6' }}>
                      <CardContent sx={{ py: 1, '&:last-child': { pb: 1 } }}>
                        <Stack direction="row" spacing={1} alignItems="flex-start">
                          <Typography variant="caption" sx={{ color: 'text.secondary', width: 48, flexShrink: 0, pt: 0.5, fontVariantNumeric: 'tabular-nums' }}>
                            {mmss(e.relMs)}
                          </Typography>
                          <Box sx={{ flex: 1, minWidth: 0 }}>
                            {editId === e.id ? (
                              <TextField
                                fullWidth
                                size="small"
                                multiline
                                value={editText}
                                onChange={(ev) => setEditText(ev.target.value)}
                                onBlur={() => {
                                  updateNote(e.id, editText);
                                  setEditId(null);
                                }}
                                onKeyDown={(ev) => {
                                  if (ev.key === 'Enter' && !ev.shiftKey) {
                                    ev.preventDefault();
                                    updateNote(e.id, editText);
                                    setEditId(null);
                                  }
                                  if (ev.key === 'Escape') setEditId(null);
                                }}
                                autoFocus
                              />
                            ) : (
                              <Typography
                                variant="body2"
                                sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', cursor: 'text' }}
                                onDoubleClick={() => {
                                  setEditId(e.id);
                                  setEditText(e.text);
                                }}
                              >
                                {e.text}
                              </Typography>
                            )}
                          </Box>
                          <Tooltip title="删除">
                            <IconButton size="small" color="error" onClick={() => removeNote(e.id)}>
                              <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </Stack>
                      </CardContent>
                    </Card>
                  ))}
                </Stack>
              )}
            </Box>
          </CardContent>
        </Card>
      </Box>
    </Box>
  );
}
