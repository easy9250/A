/**
 * 字幕流（窗口化虚拟滚动）。
 *
 * 性能约定（600+ 条不掉帧）：
 * 1) 容器**只订阅** `utteranceIds`（数组引用在 append 时变更一次），绝不订阅行内容；
 * 2) 每行 `UtteranceRow` 自己订阅 `uttMap[id]`，父级更新不触发行重渲染；
 * 3) `@tanstack/react-virtual`：`estimateSize:()=>72, overscan:8, measureElement:true`；
 * 4) interim **不进 uttMap**，由尾部独立组件 `<InterimBubble/>` 渲染 → 单次重渲染节点数 = 1。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import { useVirtualizer } from '@tanstack/react-virtual';
import { selectUtteranceIds, useMeetingStore } from '@/stores/useMeetingStore';
import { toast, useUiStore } from '@/stores/useUiStore';
import { UtteranceRow } from './UtteranceRow';
import { copyText } from '@/lib/utils';
import type { MarkerKind, Participant } from '@/types/models';

/** 字幕流入参 */
export interface TranscriptListProps {
  /** 时间码 → 跳录音播放 */
  onSeek: (ms: number) => void;
  className?: string;
}

/** 判「已在底部」的容差（px） */
const BOTTOM_TOLERANCE = 96;

/**
 * interim 气泡：独立订阅，绝不参与列表重渲染。
 */
function InterimBubble(props: { scrollRef: React.RefObject<HTMLDivElement>; follow: boolean }): JSX.Element | null {
  const interim = useUiStore((s) => s.interim);
  const interimAtMs = useUiStore((s) => s.interimAtMs);

  useEffect(() => {
    if (!props.follow) return;
    const el = props.scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [interim, props.follow, props.scrollRef]);

  if (!interim) return null;
  return (
    <Box sx={{ px: 2, py: 1 }}>
      <Typography
        variant="body2"
        sx={{
          fontStyle: 'italic',
          color: 'text.secondary',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          borderLeft: '3px dashed #9CA3AF',
          pl: 1.5,
        }}
      >
        {interim}
        <Typography component="span" variant="caption" sx={{ ml: 1, opacity: 0.6 }}>
          {Math.floor(interimAtMs / 1000)}s
        </Typography>
      </Typography>
    </Box>
  );
}

/**
 * 字幕流容器。
 */
export function TranscriptList(props: TranscriptListProps): JSX.Element {
  const { onSeek, className } = props;

  // ★ 只订阅 id 列表
  const ids = useMeetingStore(selectUtteranceIds);
  const participants = useMeetingStore((s) => s.participants) as Participant[];
  const autoFollowPref = useUiStore((s) => s.autoFollow);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState<boolean>(autoFollowPref);
  const [atBottom, setAtBottom] = useState<boolean>(true);

  useEffect(() => {
    setFollow(autoFollowPref);
  }, [autoFollowPref]);

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: ids.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 8,
    measureElement: (el: HTMLDivElement) => el.getBoundingClientRect().height,
  });

  /* ---------------- 自动跟随底部 ---------------- */
  useEffect(() => {
    if (!follow || ids.length === 0) return;
    virtualizer.scrollToIndex(ids.length - 1, { align: 'end' });
    setAtBottom(true);
  }, [ids.length, follow, virtualizer]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_TOLERANCE;
    setAtBottom(bottom);
    if (bottom) setFollow(true);
  }, []);

  const scrollToBottom = useCallback(() => {
    setFollow(true);
    if (ids.length > 0) virtualizer.scrollToIndex(ids.length - 1, { align: 'end' });
  }, [ids.length, virtualizer]);

  /* ---------------- 行回调（引用稳定，保证 memo 生效） ---------------- */
  const handleCopy = useCallback((text: string) => {
    void copyText(text).then((ok) => {
      if (ok) toast.success('已复制');
      else useUiStore.getState().notifyClipboardFallback();
    });
  }, []);

  const handleEdit = useCallback((id: string, text: string) => {
    useMeetingStore.getState().updateUtterance(id, { text });
  }, []);

  const handleDelete = useCallback((id: string) => {
    void (async () => {
      const ok = await useUiStore
        .getState()
        .requestConfirm({ title: '删除这条发言', body: '删除后可用 Ctrl/Cmd + Z 撤销', confirmText: '删除', danger: true });
      if (!ok) return;
      useMeetingStore.getState().deleteUtterance(id);
      toast.success('已删除，可用 Ctrl/Cmd + Z 撤销');
    })();
  }, []);

  const handleReassign = useCallback((id: string, speakerId: string | null) => {
    useMeetingStore.getState().reassignUtterance(id, speakerId);
  }, []);

  const handleReassignFromHere = useCallback((id: string, speakerId: string | null) => {
    const n = useMeetingStore.getState().reassignFromHere(id, speakerId);
    if (n > 0) toast.success(`已批量修改 ${n} 条发言的归属`);
  }, []);

  const handleMarker = useCallback((id: string, kind: MarkerKind | null) => {
    useMeetingStore.getState().setMarker(id, kind);
  }, []);

  const handleMergeNext = useCallback((id: string) => {
    const st = useMeetingStore.getState();
    const idx = st.utteranceIds.indexOf(id);
    const nextId = idx >= 0 ? st.utteranceIds[idx + 1] : undefined;
    if (!nextId) {
      toast.info('已经是最后一条，无法与下一条合并');
      return;
    }
    const merged = st.mergeUtterances([id, nextId]);
    if (merged) toast.success('已合并 2 条发言');
  }, []);

  const handleSplit = useCallback((id: string, at: number) => {
    const newId = useMeetingStore.getState().splitUtterance(id, at);
    if (newId) toast.success('已拆分为 2 条发言');
    else toast.warning('拆分位置不合法，请选在文字中间');
  }, []);

  const items = virtualizer.getVirtualItems();

  return (
    <Paper
      variant="outlined"
      className={className}
      sx={{ position: 'relative', display: 'flex', minHeight: 0, flexDirection: 'column', overflow: 'hidden' }}
    >
      <div ref={scrollRef} onScroll={handleScroll} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {ids.length === 0 ? (
          <Stack alignItems="center" justifyContent="center" sx={{ height: '100%', py: 6, opacity: 0.7 }}>
            <Typography variant="body2" color="text.secondary">
              还没有发言 —— 开始说话后字幕会实时出现在这里
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
              提示：先点击下方头像条选择当前发言人，识别结果会自动归属
            </Typography>
          </Stack>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
            {items.map((item) => {
              const id = ids[item.index];
              return (
                <div
                  key={id}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
                >
                  <UtteranceRow
                    id={id}
                    participants={participants}
                    onSeek={onSeek}
                    onCopy={handleCopy}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                    onReassign={handleReassign}
                    onReassignFromHere={handleReassignFromHere}
                    onMarker={handleMarker}
                    onMergeNext={handleMergeNext}
                    onSplit={handleSplit}
                  />
                </div>
              );
            })}
          </div>
        )}
        {/* ★ interim 独立渲染，不进 uttMap */}
        <InterimBubble scrollRef={scrollRef} follow={follow} />
      </div>

      {!atBottom && ids.length > 0 ? (
        <Button
          size="small"
          variant="contained"
          startIcon={<ArrowDownwardIcon sx={{ fontSize: 16 }} />}
          onClick={scrollToBottom}
          sx={{ position: 'absolute', right: 16, bottom: 12, borderRadius: 999 }}
        >
          回到底部
        </Button>
      ) : null}
    </Paper>
  );
}

export default TranscriptList;
