import { useCallback, useEffect, useRef, useState } from 'react';
import { HashRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import AppHeader from '@/components/AppHeader';
import { ConfirmDialog } from '@/components/common/UiKit';
import { useUiStore, toastSel } from '@/stores/useUiStore';
import { useMeetingStore } from '@/stores/useMeetingStore';
import { getRepo, attachCloudMirror } from '@/core/repo';
import { cloudbaseClient } from '@/core/cloud/CloudBaseClient';
import { debounce, fmtDateTime } from '@/lib/utils';
import type { MeetingSummary } from '@/types/models';
import LivePage from '@/pages/LivePage';
import ReviewPage from '@/pages/ReviewPage';
import HistoryPage from '@/pages/HistoryPage';
import QuickSessionPage from '@/pages/QuickSessionPage';

/** 自动落盘防抖时间（会中 5s） */
const AUTO_SAVE_MS = 5000;

/** 判断焦点是否在输入态（此时不触发空格等快捷键） */
function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node || !node.tagName) return false;
  const tag = node.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || node.isContentEditable === true;
}

/** 向 window 派发全局语义事件，供 T04/T05 页面自行监听 */
function emit(name: string, detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/**
 * 应用根组件：
 * 1) 三条 HashRouter 路由；
 * 2) 启动 bootstrap：云端探测（3s 超时，非阻塞）+ 恢复未结束会议；
 * 3) 全局快捷键骨架（语义事件广播，具体行为由各页面实现）；
 * 4) 5s 防抖自动落盘；
 * 5) Toast / Confirm 宿主。
 */
function AppShell(): JSX.Element {
  const navigate = useNavigate();
  const setCloudStatus = useUiStore((s) => s.setCloudStatus);
  const toastItem = useUiStore(toastSel);
  const dismissToast = useUiStore((s) => s.dismissToast);
  const starHotkeyEnabled = useUiStore((s) => s.starHotkeyEnabled);

  const [resumable, setResumable] = useState<MeetingSummary | null>(null);
  const flushRef = useRef<() => Promise<void>>(async () => undefined);

  /* ---------------- 立即落盘（供快捷键 / 关键操作调用） ---------------- */
  const flush = useCallback(async (): Promise<void> => {
    const st = useMeetingStore.getState();
    if (!st.meeting || !st.dirty) return;
    const snap = st.getSnapshot();
    if (!snap) return;
    st.setSaving(true);
    try {
      await getRepo().saveSnapshot(snap);
      st.markSaved();
    } catch {
      useUiStore.getState().toast.error('保存失败，请及时导出备份');
    } finally {
      useMeetingStore.getState().setSaving(false);
    }
  }, []);
  flushRef.current = flush;

  /* ---------------- bootstrap：云端探测（绝不阻塞首屏） ---------------- */
  useEffect(() => {
    let alive = true;
    setCloudStatus('probing');
    void cloudbaseClient
      .probe(3000)
      .then((status) => {
        if (!alive) return;
        setCloudStatus(status, cloudbaseClient.getReason());
        if (status === 'cloud') attachCloudMirror();
      })
      .catch(() => {
        if (!alive) return;
        setCloudStatus('local', '云端初始化失败，已使用本地模式继续');
      });
    return () => {
      alive = false;
    };
  }, [setCloudStatus]);

  /* ---------------- bootstrap：恢复未结束的会议 ---------------- */
  useEffect(() => {
    let alive = true;
    void getRepo()
      .listSummaries()
      .then((list) => {
        if (!alive) return;
        const pending = list.find((m) => m.meeting.status !== 'ended');
        setResumable(pending ?? null);
      });
    return () => {
      alive = false;
    };
  }, []);

  /* ---------------- 5s 防抖自动落盘 ---------------- */
  useEffect(() => {
    const debouncedSave = debounce(() => {
      void flushRef.current();
    }, AUTO_SAVE_MS);
    const unsub = useMeetingStore.subscribe(
      (s) => s.dirty,
      (dirty) => {
        if (dirty) debouncedSave();
      },
    );
    // 页面关闭前尽力落盘
    const onBeforeUnload = (): void => {
      debouncedSave.flush();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      unsub();
      debouncedSave.cancel();
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  /* ---------------- 全局快捷键骨架 ---------------- */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey;
      const typing = isTypingTarget(e.target);

      if (e.key === 'Escape') {
        emit('mm:escape');
        return;
      }
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void flushRef.current();
        useUiStore.getState().toast.success('已保存');
        return;
      }
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        navigate('/');
        // 让目标页面聚焦搜索框
        window.setTimeout(() => emit('mm:focus-search'), 60);
        return;
      }
      if (typing) return;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        const ok = useMeetingStore.getState().undo();
        if (!ok) useUiStore.getState().toast.info('没有可撤销的操作');
        return;
      }
      if (mod && e.key.toLowerCase() === 'm' && starHotkeyEnabled) {
        e.preventDefault();
        emit('mm:star');
        return;
      }
      if (mod && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        emit('mm:select-speaker', { index: Number(e.key) });
        return;
      }
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        emit('mm:toggle-pause');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, starHotkeyEnabled]);

  /* ---------------- 恢复入口 ---------------- */
  const handleResume = useCallback(() => {
    if (!resumable) return;
    navigate(`/live/${resumable.meeting.id}`);
  }, [navigate, resumable]);

  const handleDiscardResume = useCallback(() => setResumable(null), []);

  return (
    <div className="flex min-h-screen flex-col bg-[#F5F7FB]">
      <AppHeader />

      {resumable ? (
        <div className="px-3 pt-2">
          <Alert
            severity="info"
            action={
              <>
                <Button size="small" onClick={handleResume}>
                  继续这场会议
                </Button>
                <Button size="small" color="inherit" onClick={handleDiscardResume}>
                  忽略
                </Button>
              </>
            }
          >
            检测到未结束的会议「{resumable.meeting.title}」（开始于 {fmtDateTime(resumable.meeting.startedAt)}），是否继续？
          </Alert>
        </div>
      ) : null}

      <main className="flex min-h-0 flex-1 flex-col">
        <Routes>
          <Route path="/" element={<HistoryPage />} />
          <Route path="/live/:id" element={<LivePage />} />
          <Route path="/quick" element={<QuickSessionPage />} />
          <Route path="/review/:id" element={<ReviewPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      {/* Toast 宿主 */}
      <Snackbar
        open={Boolean(toastItem)}
        autoHideDuration={toastItem?.duration ?? 3000}
        onClose={() => toastItem && dismissToast(toastItem.id)}
        message={toastItem?.msg ?? ''}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        action={
          <IconButton size="small" color="inherit" onClick={() => toastItem && dismissToast(toastItem.id)}>
            <CloseIcon fontSize="small" />
          </IconButton>
        }
      />

      {/* 二次确认宿主 */}
      <ConfirmDialog />
    </div>
  );
}

/**
 * 应用入口：使用 HashRouter（CloudBase 静态托管默认无 SPA fallback，hash 路由零配置可用）。
 */
export default function App(): JSX.Element {
  return (
    <HashRouter>
      <AppShell />
    </HashRouter>
  );
}
