import { useEffect, useMemo, useState } from 'react';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { Origin, Topic, Utterance } from '@/types/models';
import { hhmmss } from '@/lib/utils';

export interface TopicSectionProps {
  topic: Topic;
  index: number;
  total: number;
  utterances: Utterance[];
  /** 编辑（800ms 防抖保存由页面统一处理） */
  onUpdate: (id: string, patch: Partial<Pick<Topic, 'title' | 'summary' | 'bullets' | 'origin'>>) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  /** 溯源跳转：滚动到原始发言并播放录音 */
  onLocate: (utteranceId: string) => void;
}

/**
 * 议题段卡片。
 * 候选态（origin=rule/ai）虚线边框 + 「确认」按钮；用户确认/编辑后转 origin=manual → 实线。
 */
export default function TopicSection(props: TopicSectionProps): JSX.Element {
  const { topic, index, total, utterances, onUpdate, onRemove, onMove, onLocate } = props;
  const [title, setTitle] = useState(topic.title);
  const [expanded, setExpanded] = useState(false);
  const [draftBullet, setDraftBullet] = useState('');

  useEffect(() => setTitle(topic.title), [topic.title]);

  const isCandidate = topic.origin !== 'manual';

  /** 段内原始发言（按 start/end utteranceId 定位，缺失时回退为空） */
  const rawUtterances = useMemo<Utterance[]>(() => {
    const s = utterances.findIndex((u) => u.id === topic.startUtteranceId);
    const e = utterances.findIndex((u) => u.id === topic.endUtteranceId);
    if (s < 0) return [];
    const end = e >= s ? e : s;
    return utterances.slice(s, end + 1);
  }, [utterances, topic.startUtteranceId, topic.endUtteranceId]);

  const commitTitle = (): void => {
    const next = title.trim();
    if (!next || next === topic.title) {
      setTitle(topic.title);
      return;
    }
    onUpdate(topic.id, { title: next, origin: 'manual' });
  };

  const setBullets = (bullets: string[]): void => onUpdate(topic.id, { bullets, origin: 'manual' });

  const addBullet = (): void => {
    const b = draftBullet.trim();
    if (!b) return;
    setBullets([...topic.bullets, b]);
    setDraftBullet('');
  };

  return (
    <Card
      variant="outlined"
      sx={{
        borderStyle: isCandidate ? 'dashed' : 'solid',
        borderColor: isCandidate ? 'warning.main' : 'divider',
        bgcolor: isCandidate ? 'rgba(230,159,0,0.03)' : 'background.paper',
      }}
    >
      <CardContent>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
          <Chip size="small" label={`议题 ${index + 1}`} color="primary" variant="outlined" />
          {isCandidate ? (
            <Chip size="small" label="候选待确认" color="warning" variant="outlined" />
          ) : null}
          <div style={{ flex: 1 }} />
          <Tooltip title="上移" arrow>
            <span>
              <IconButton size="small" disabled={index === 0} onClick={() => onMove(topic.id, -1)}>
                <ArrowUpwardIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="下移" arrow>
            <span>
              <IconButton size="small" disabled={index >= total - 1} onClick={() => onMove(topic.id, 1)}>
                <ArrowDownwardIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          {isCandidate ? (
            <Tooltip title="确认该议题（转为实线，表示已人工认可）" arrow>
              <IconButton size="small" color="success" onClick={() => onUpdate(topic.id, { origin: 'manual' })}>
                <CheckCircleOutlineIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : null}
          <Tooltip title="删除该议题" arrow>
            <IconButton size="small" color="error" onClick={() => onRemove(topic.id)}>
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>

        <TextField
          fullWidth
          size="small"
          variant="standard"
          value={title}
          placeholder="议题名称"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setTitle(topic.title);
              (e.target as HTMLInputElement).blur();
            }
          }}
          inputProps={{ sx: { fontWeight: 600, fontSize: 15 } }}
        />

        <div className="mt-2">
          {topic.bullets.map((b, i) => (
            <Stack key={`${i}-${b}`} direction="row" alignItems="flex-start" spacing={0.5}>
              <span className="mt-2 text-slate-400">•</span>
              <TextField
                fullWidth
                size="small"
                variant="standard"
                multiline
                value={b}
                onChange={(e) => {
                  const next = [...topic.bullets];
                  next[i] = e.target.value;
                  setBullets(next);
                }}
              />
              <IconButton
                size="small"
                onClick={() => setBullets(topic.bullets.filter((_, idx) => idx !== i))}
                aria-label="删除要点"
              >
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Stack>
          ))}

          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
            <TextField
              size="small"
              variant="standard"
              placeholder="新增要点…"
              value={draftBullet}
              onChange={(e) => setDraftBullet(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addBullet();
                }
              }}
              sx={{ flex: 1 }}
            />
            <IconButton size="small" color="primary" onClick={addBullet} disabled={!draftBullet.trim()}>
              <AddIcon fontSize="small" />
            </IconButton>
          </Stack>
        </div>

        <Divider sx={{ my: 1.5 }} />

        <Stack
          direction="row"
          alignItems="center"
          spacing={0.5}
          sx={{ cursor: 'pointer', color: 'text.secondary' }}
          onClick={() => setExpanded((v) => !v)}
        >
          <ExpandMoreIcon
            fontSize="small"
            sx={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}
          />
          <Typography variant="caption">原始发言（{rawUtterances.length} 条）</Typography>
        </Stack>
        <Collapse in={expanded} unmountOnExit>
          <div className="mt-1 max-h-64 overflow-auto scroll-thin">
            {rawUtterances.length === 0 ? (
              <Typography variant="caption" color="text.secondary">
                该议题未绑定发言区间
              </Typography>
            ) : (
              rawUtterances.map((u) => (
                <div
                  key={u.id}
                  className="cursor-pointer rounded px-1 py-0.5 text-xs hover:bg-slate-50"
                  onClick={() => onLocate(u.id)}
                  title="点击跳转到该发言并播放录音"
                >
                  <span className="mr-1 font-mono text-slate-400">[{hhmmss(u.startMs)}]</span>
                  {u.text}
                </div>
              ))
            )}
          </div>
        </Collapse>
      </CardContent>
    </Card>
  );
}

/** 便于外部复用的候选判定 */
export function isCandidateOrigin(origin: Origin): boolean {
  return origin !== 'manual';
}
