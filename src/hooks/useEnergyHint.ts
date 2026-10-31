/**
 * P1-05 能量突变提示 Hook。
 *
 * ★ 铁律：只做**非模态提示**，绝不自动改写任何一条发言的 speakerId。
 *
 * 行为：
 * - 订阅 `mediaController.onEnergySpike`；
 * - 开关关闭（设置项 `energyHintEnabled`）时完全不订阅；
 * - 提示走 toast（非模态）+ 返回最近一次突变供页面内联展示；
 * - 同类提示最短间隔 10s，避免刷屏。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { mediaController, type EnergySpike } from '@/core/audio/MediaController';
import { useUiStore } from '@/stores/useUiStore';
import { mmss } from '@/lib/utils';

/** 一条能量突变提示 */
export interface EnergyHintItem {
  /** 相对会议开始的活动毫秒 */
  atMs: number;
  /** 突变倍数 */
  delta: number;
  /** 提示文案 */
  text: string;
  /** 去重 key */
  key: string;
}

/** 两次提示之间的最小间隔（ms） */
const HINT_COOLDOWN_MS = 10000;

export interface UseEnergyHintResult {
  /** 最近一次突变提示；null 表示无 */
  hint: EnergyHintItem | null;
  /** 手动关闭当前提示 */
  dismiss: () => void;
}

/**
 * 能量突变提示。
 * @param enabled 是否开启（来自设置项 energyHintEnabled）
 */
export function useEnergyHint(enabled: boolean): UseEnergyHintResult {
  const [hint, setHint] = useState<EnergyHintItem | null>(null);
  const lastToastAtRef = useRef<number>(0);

  const dismiss = useCallback(() => setHint(null), []);

  useEffect(() => {
    if (!enabled) {
      setHint(null);
      return undefined;
    }
    const off = mediaController.onEnergySpike((e: EnergySpike) => {
      const item: EnergyHintItem = {
        atMs: e.atMs,
        delta: e.delta,
        text: `${mmss(e.atMs)} 附近检测到音量突变（${e.delta.toFixed(1)}×），可能更换了发言人`,
        key: `spike-${e.atMs}`,
      };
      setHint(item);
      const now = Date.now();
      if (now - lastToastAtRef.current >= HINT_COOLDOWN_MS) {
        lastToastAtRef.current = now;
        // 非模态提示：不打断、不弹窗、不改写归属
        useUiStore.getState().toast.info(item.text);
      }
    });
    return off;
  }, [enabled]);

  return { hint, dismiss };
}

export default useEnergyHint;
