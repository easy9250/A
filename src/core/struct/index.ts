import type {
  ActionItem,
  Decision,
  Meeting,
  Origin,
  Participant,
  Topic,
  Utterance,
} from '@/types/models';
import { RuleStructurer } from './RuleStructurer';
import { CloudAiStructurer } from './CloudAiStructurer';
import { cloudbaseClient } from '../cloud/CloudBaseClient';
import { toast, useUiStore } from '@/stores/useUiStore';
import { withTimeout } from '@/lib/utils';

/** 结构化入参 */
export interface StructInput {
  meeting: Meeting;
  participants: Participant[];
  /** 按 seq 升序 */
  utterances: Utterance[];
}

/** 结构化产出（两条路径结构完全一致，只有 origin 不同） */
export interface StructResult {
  topics: Omit<Topic, 'createdAt'>[];
  decisions: Omit<Decision, 'createdAt'>[];
  actionItems: Omit<ActionItem, 'createdAt'>[];
  origin: Origin;
}

/** 结构化器统一接口 */
export interface IStructurer {
  readonly kind: 'ai' | 'rule';
  structure(input: StructInput, onPartial?: (p: Partial<StructResult>) => void): Promise<StructResult>;
}

/** AI 结构化硬超时（P0-12② / §7.6）：超时即回落本地规则 */
export const AI_TIMEOUT_MS = 12000;
/** 首选模型（PRD A6） */
export const PRIMARY_MODEL = 'hunyuan-2.0-instruct-20251111';
/** 兜底模型（CloudBase 默认） */
export const DEFAULT_MODEL = 'hunyuan-exp';

/**
 * 工厂：优先 AI；无云 / 无 AI 句柄 → 直接用本地规则。
 * 注意：AI 调用期的超时与异常回落由 `structureMeeting()` 统一兜底。
 */
export async function createStructurer(): Promise<IStructurer> {
  const cloudEnabled = useUiStore.getState().cloudEnabled;
  if (!cloudEnabled) return new RuleStructurer();
  try {
    const status = await cloudbaseClient.probe(3000);
    if (status !== 'cloud') return new RuleStructurer();
    let model = await cloudbaseClient.getAiModel(PRIMARY_MODEL);
    let name: string = PRIMARY_MODEL;
    if (!model) {
      model = await cloudbaseClient.getAiModel(DEFAULT_MODEL);
      name = DEFAULT_MODEL;
    }
    if (!model) return new RuleStructurer();
    return new CloudAiStructurer(model, name);
  } catch {
    return new RuleStructurer();
  }
}

/**
 * 执行一次结构化整理（带三级自愈）：
 *   ① AI 指定模型 → ② AI 默认模型（CloudAiStructurer 内部自愈）→ ③ 本地规则引擎
 * 任一步超时 / 抛错都会 toast 提示并回落规则引擎，**永不静默失败**。
 */
export async function structureMeeting(
  input: StructInput,
  onPartial?: (p: Partial<StructResult>) => void,
): Promise<StructResult> {
  const structurer = await createStructurer();
  if (structurer.kind !== 'ai') return structurer.structure(input, onPartial);

  try {
    const res = await withTimeout(structurer.structure(input, onPartial), AI_TIMEOUT_MS, null);
    if (res) return res;
    toast.warning('AI 整理超时，已使用本地规则生成初稿');
  } catch {
    toast.warning('AI 整理失败，已使用本地规则生成初稿');
  }
  return new RuleStructurer().structure(input, onPartial);
}

export { RuleStructurer, CloudAiStructurer };
