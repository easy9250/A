/**
 * 腾讯云 ASR 凭证来源。
 *
 * 优先级：运行时在「设置」中填写的凭证（持久化到 useUiStore） > 构建期环境变量
 * （VITE_TENCENT_ASR_SECRET_ID / VITE_TENCENT_ASR_SECRET_KEY / VITE_TENCENT_ASR_APP_ID）。
 *
 * 任何一层有完整三件套即视为「已配置」，createSpeechProvider 会据此优先走腾讯云实时转写。
 */
import { useUiStore } from '@/stores/useUiStore';
import { isTencentConfigured, type TencentAsrConfig } from '@/core/asr/tencent';

/** 从构建环境变量读取（CI / 自托管部署时注入，避免把密钥写进前端代码） */
function fromEnv(): TencentAsrConfig {
  return {
    secretId: import.meta.env.VITE_TENCENT_ASR_SECRET_ID ?? '',
    secretKey: import.meta.env.VITE_TENCENT_ASR_SECRET_KEY ?? '',
    appId: import.meta.env.VITE_TENCENT_ASR_APP_ID ?? '',
  };
}

/** 取当前生效的腾讯云 ASR 凭证；不完整返回 null */
export function getTencentAsrConfig(): TencentAsrConfig | null {
  const pref = useUiStore.getState().tencentAsr;
  const env = fromEnv();
  const merged: TencentAsrConfig = {
    secretId: pref?.secretId || env.secretId,
    secretKey: pref?.secretKey || env.secretKey,
    appId: pref?.appId || env.appId,
  };
  return isTencentConfigured(merged) ? merged : null;
}

/** 是否已在设置中显式填写（用于 UI 上提示「已配置」） */
export function hasStoredTencentAsr(): boolean {
  const pref = useUiStore.getState().tencentAsr;
  return isTencentConfigured(pref);
}
