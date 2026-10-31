import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { CloudStatus, LangCode, SpeechLevel } from '@/types/models';
import type { TencentAsrConfig } from '@/core/asr/tencent';

/** Toast 类型 */
export type ToastKind = 'success' | 'error' | 'warning' | 'info';

/** Toast 条目 */
export interface ToastItem {
  id: string;
  kind: ToastKind;
  msg: string;
  /** 可选的行动按钮文案 */
  actionText?: string;
  /** 点击行动按钮的回调 */
  onAction?: () => void;
  /** 自动关闭毫秒 */
  duration?: number;
}

/** 确认弹窗请求（由 ConfirmDialog 消费） */
export interface ConfirmRequest {
  open: boolean;
  title: string;
  body?: string;
  confirmText: string;
  cancelText: string;
  danger?: boolean;
  /** resolve 用户选择结果 */
  resolve?: (ok: boolean) => void;
}

/** 设置弹窗内的偏好项（会被 persist 到 localStorage） */
export interface UiPreferences {
  lang: LangCode;
  deviceId: string;
  /** P1-05 能量突变提示开关 */
  energyHintEnabled: boolean;
  /** 是否允许连接云端（关 = 永不上传） */
  cloudEnabled: boolean;
  /** Ctrl/Cmd+M 打点快捷键绑定开关（macOS 可能冲突） */
  starHotkeyEnabled: boolean;
  /** 自动跟随字幕流底部 */
  autoFollow: boolean;
  /** 腾讯云实时语音识别凭证（留空则不使用云端 ASR，回退到浏览器 / 录音模式） */
  tencentAsr: TencentAsrConfig;
}

export interface UiState extends UiPreferences {
  /* ---------- 状态徽标 ---------- */
  cloudStatus: CloudStatus;
  /** 云端降级原因（展示在降级提示条） */
  cloudReason: string;
  speechLevel: SpeechLevel;
  /** 模式徽标文案，如「实时识别中」「录音模式」「本地模式（手动）」 */
  speechLabel: string;
  /** 顶部降级提示条内容；null 表示不展示 */
  bannerMsg: string | null;
  /** 提示条级别 */
  bannerKind: ToastKind;
  /** 提示条上的行动按钮 */
  bannerAction?: { text: string; onClick: () => void } | null;

  /* ---------- interim 文本（不进 uttMap，独立渲染） ---------- */
  interim: string;
  interimAtMs: number;

  /* ---------- 弹窗 ---------- */
  settingsOpen: boolean;
  confirm: ConfirmRequest;

  /* ---------- Toast ---------- */
  toasts: ToastItem[];

  /* ---------- Actions ---------- */
  setCloudStatus: (s: CloudStatus, reason?: string) => void;
  setSpeechLevel: (lv: SpeechLevel, label?: string) => void;
  setBanner: (msg: string | null, kind?: ToastKind, action?: { text: string; onClick: () => void } | null) => void;
  setLang: (l: LangCode) => void;
  setDeviceId: (id: string) => void;
  setEnergyHintEnabled: (v: boolean) => void;
  setCloudEnabled: (v: boolean) => void;
  setStarHotkeyEnabled: (v: boolean) => void;
  setAutoFollow: (v: boolean) => void;
  /** 写入腾讯云 ASR 凭证（部分更新） */
  setTencentAsr: (partial: Partial<TencentAsrConfig>) => void;
  setInterim: (text: string, atMs?: number) => void;
  openSettings: () => void;
  closeSettings: () => void;
  /** 二次确认；返回 Promise<boolean> */
  requestConfirm: (opts: {
    title: string;
    body?: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
  }) => Promise<boolean>;
  resolveConfirm: (ok: boolean) => void;
  pushToast: (kind: ToastKind, msg: string, opts?: { actionText?: string; onAction?: () => void; duration?: number }) => void;
  dismissToast: (id: string) => void;
  /** 便捷方法集合 */
  toast: {
    success: (msg: string) => void;
    error: (msg: string, opts?: { actionText?: string; onAction?: () => void }) => void;
    warning: (msg: string, opts?: { actionText?: string; onAction?: () => void }) => void;
    info: (msg: string) => void;
  };
  /** 剪贴板不可用时的降级提示 */
  notifyClipboardFallback: () => void;
  resetPreferences: () => void;
}

const DEFAULT_PREFERENCES: UiPreferences = {
  lang: 'zh-CN',
  deviceId: '',
  energyHintEnabled: true,
  cloudEnabled: true,
  starHotkeyEnabled: true,
  autoFollow: true,
  tencentAsr: { secretId: '', secretKey: '', appId: '' },
};

const EMPTY_CONFIRM: ConfirmRequest = {
  open: false,
  title: '',
  body: '',
  confirmText: '确定',
  cancelText: '取消',
  danger: false,
};

let toastSeq = 0;
let clipboardWarned = false;

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_PREFERENCES,

      cloudStatus: 'probing',
      cloudReason: '',
      speechLevel: 0,
      speechLabel: '未开始',
      bannerMsg: null,
      bannerKind: 'info' as ToastKind,
      bannerAction: null,

      interim: '',
      interimAtMs: 0,

      settingsOpen: false,
      confirm: { ...EMPTY_CONFIRM },
      toasts: [],

      setCloudStatus: (s, reason = '') => set({ cloudStatus: s, cloudReason: reason }),
      setSpeechLevel: (lv, label) =>
        set((st) => ({
          speechLevel: lv,
          speechLabel: label ?? (lv === 0 ? '实时识别中' : lv === 1 ? '录音模式' : '本地模式（手动）'),
        })),
      setBanner: (msg, kind = 'warning', action = null) =>
        set({ bannerMsg: msg, bannerKind: kind, bannerAction: action }),

      setLang: (l) => set({ lang: l }),
      setDeviceId: (id) => set({ deviceId: id }),
      setEnergyHintEnabled: (v) => set({ energyHintEnabled: v }),
      setCloudEnabled: (v) => set({ cloudEnabled: v }),
      setStarHotkeyEnabled: (v) => set({ starHotkeyEnabled: v }),
      setAutoFollow: (v) => set({ autoFollow: v }),
      setTencentAsr: (partial) =>
        set((s) => ({ tencentAsr: { ...s.tencentAsr, ...partial } })),
      setInterim: (text, atMs = 0) => set({ interim: text, interimAtMs: atMs }),

      openSettings: () => set({ settingsOpen: true }),
      closeSettings: () => set({ settingsOpen: false }),

      requestConfirm: (opts) =>
        new Promise<boolean>((resolve) => {
          set({
            confirm: {
              open: true,
              title: opts.title,
              body: opts.body ?? '',
              confirmText: opts.confirmText ?? '确定',
              cancelText: opts.cancelText ?? '取消',
              danger: opts.danger ?? false,
              resolve,
            },
          });
        }),
      resolveConfirm: (ok) => {
        const c = get().confirm;
        c.resolve?.(ok);
        set({ confirm: { ...EMPTY_CONFIRM } });
      },

      pushToast: (kind, msg, opts) => {
        toastSeq += 1;
        const item: ToastItem = {
          id: `t-${Date.now().toString(36)}-${toastSeq}`,
          kind,
          msg,
          actionText: opts?.actionText,
          onAction: opts?.onAction,
          duration: opts?.duration ?? 3000,
        };
        set((st) => ({ toasts: [...st.toasts, item].slice(-3) }));
        window.setTimeout(() => get().dismissToast(item.id), item.duration);
      },
      dismissToast: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),

      toast: {
        success: (msg) => get().pushToast('success', msg),
        error: (msg, opts) => get().pushToast('error', msg, opts),
        warning: (msg, opts) => get().pushToast('warning', msg, opts),
        info: (msg) => get().pushToast('info', msg),
      },

      notifyClipboardFallback: () => {
        if (clipboardWarned) return;
        clipboardWarned = true;
        get().pushToast('warning', '当前环境不支持剪贴板，请手动复制弹窗中的内容', { duration: 4000 });
      },

      resetPreferences: () => set({ ...DEFAULT_PREFERENCES }),
    }),
    {
      name: 'meetingmind.ui',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // 仅持久化偏好项，运行状态（toast/interim/弹窗）不落地
      partialize: (s): UiPreferences => ({
        lang: s.lang,
        deviceId: s.deviceId,
        energyHintEnabled: s.energyHintEnabled,
        cloudEnabled: s.cloudEnabled,
        starHotkeyEnabled: s.starHotkeyEnabled,
        autoFollow: s.autoFollow,
        tencentAsr: s.tencentAsr,
      }),
    },
  ),
);

/** selector：当前最上面的一条 Toast（Snackbar 宿主用） */
export const toastSel = (s: UiState): ToastItem | null => (s.toasts.length > 0 ? s.toasts[0] : null);

/** 供非 React 模块（core/）直接弹提示使用 */
export const toast = {
  success: (msg: string): void => useUiStore.getState().toast.success(msg),
  error: (msg: string, opts?: { actionText?: string; onAction?: () => void }): void =>
    useUiStore.getState().toast.error(msg, opts),
  warning: (msg: string, opts?: { actionText?: string; onAction?: () => void }): void =>
    useUiStore.getState().toast.warning(msg, opts),
  info: (msg: string): void => useUiStore.getState().toast.info(msg),
};
