import type { ActionItem, ActionPriority, Decision, Participant, Topic, Utterance } from '@/types/models';
import { UNKNOWN_SPEAKER_ID } from '@/types/models';
import type { IStructurer, StructInput, StructResult } from './index';
import { DEFAULT_MODEL } from './index';
import { cloudbaseClient } from '../cloud/CloudBaseClient';
import { newId } from '@/lib/utils';

/** 单次请求文本上限（超出按此分片） */
const CHUNK_CHARS = 8000;

/** AI 返回的松散结构 */
interface RawResult {
  topics?: Array<{ title?: string; summary?: string; bullets?: string[]; startUtteranceId?: string; endUtteranceId?: string }>;
  decisions?: Array<{ content?: string; sourceUtteranceIds?: string[] }>;
  actionItems?: Array<{
    content?: string;
    assigneeName?: string;
    dueDate?: string;
    priority?: string;
    sourceUtteranceIds?: string[];
  }>;
}

/** 模型句柄的极简形态（CloudBase AI SDK 可能提供 generateText / chat 两种入口） */
interface AiModelLike {
  generateText?: (opts: unknown) => Promise<unknown>;
  chat?: (opts: unknown) => Promise<unknown>;
  [key: string]: unknown;
}

/** 从模型响应里抽出文本（兼容多种返回形态） */
function pickText(res: unknown): string {
  if (typeof res === 'string') return res;
  const r = res as Record<string, unknown> | null;
  if (!r) return '';
  const direct = r.content ?? r.text ?? r.answer ?? r.reply;
  if (typeof direct === 'string') return direct;
  const data = r.data as Record<string, unknown> | undefined;
  if (data) {
    const inner = data.content ?? data.text ?? data.answer;
    if (typeof inner === 'string') return inner;
  }
  const choices = r.choices as Array<{ message?: { content?: string }; text?: string }> | undefined;
  if (Array.isArray(choices) && choices.length > 0) {
    const c = choices[0];
    const t = c?.message?.content ?? c?.text;
    if (typeof t === 'string') return t;
  }
  return '';
}

/**
 * 从可能带 ```json 围栏 / 前后解释文字 / 被截断的字符串里抠出 JSON 对象。
 * 解析失败返回 null（交由上层回落规则引擎），绝不抛异常到 UI。
 */
export function extractJsonObject(raw: string): unknown | null {
  if (!raw) return null;
  let s = raw.trim();
  // 去掉代码围栏
  s = s.replace(/^```(?:json|JSON)?\s*/, '').replace(/```\s*$/, '');
  s = s.trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);

  const attempts: string[] = [s];
  // 常见破损：尾随逗号
  attempts.push(s.replace(/,\s*([}\]])/g, '$1'));
  // 常见破损：被截断 → 依次补齐括号
  const opens = (s.match(/{/g) ?? []).length - (s.match(/}/g) ?? []).length;
  const arrOpen = (s.match(/\[/g) ?? []).length - (s.match(/\]/g) ?? []).length;
  let repaired = s.replace(/,\s*$/, '');
  for (let i = 0; i < Math.max(0, arrOpen); i += 1) repaired += ']';
  for (let i = 0; i < Math.max(0, opens); i += 1) repaired += '}';
  attempts.push(repaired);

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* 继续尝试下一种修复 */
    }
  }
  return null;
}

/** 把发言序列化成 `[id] 姓名：文本` 供模型阅读 */
function renderUtterances(utterances: Utterance[], participants: Participant[]): string {
  const nameOf = (id: string | null): string =>
    participants.find((p) => p.id === id)?.name ?? '未知发言人';
  return utterances.map((u) => `[${u.id}] ${nameOf(u.speakerId)}：${u.text}`).join('\n');
}

/** 按字符数分片（不切断单条发言） */
export function chunkUtterances(utterances: Utterance[], limit = CHUNK_CHARS): Utterance[][] {
  const chunks: Utterance[][] = [];
  let cur: Utterance[] = [];
  let size = 0;
  for (const u of utterances) {
    const len = u.text.length + 24;
    if (cur.length > 0 && size + len > limit) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(u);
    size += len;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks.length > 0 ? chunks : [[]];
}

/**
 * CloudBase AI 结构化器。
 * 三级自愈：指定模型 → 默认 `hunyuan-exp` → 抛错交给上层回落 `RuleStructurer`。
 */
export class CloudAiStructurer implements IStructurer {
  readonly kind = 'ai' as const;
  private model: AiModelLike;
  private modelName: string;

  constructor(model: unknown, modelName: string) {
    this.model = model as AiModelLike;
    this.modelName = modelName;
  }

  async structure(input: StructInput, onPartial?: (p: Partial<StructResult>) => void): Promise<StructResult> {
    const { meeting, participants, utterances } = input;
    const utts = [...utterances].sort((a, b) => a.seq - b.seq);
    const chunks = chunkUtterances(utts);

    const topics: Omit<Topic, 'createdAt'>[] = [];
    const decisions: Omit<Decision, 'createdAt'>[] = [];
    const actionItems: Omit<ActionItem, 'createdAt'>[] = [];

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      if (chunk.length === 0) continue;
      const prompt = this.buildPrompt(meeting.title, participants, chunk, i + 1, chunks.length);
      const raw = await this.callModel(prompt);
      const parsed = extractJsonObject(raw) as RawResult | null;
      if (!parsed) continue;

      const validIds = new Set(chunk.map((u) => u.id));
      const part = this.align(parsed, meeting.id, participants, validIds);
      topics.push(...part.topics);
      decisions.push(...part.decisions);
      actionItems.push(...part.actionItems);
      onPartial?.({ topics: [...topics], decisions: [...decisions], actionItems: [...actionItems] });
    }

    // 重排 order，保证与本地规则路径结构一致
    return {
      topics: topics.map((t, i) => ({ ...t, order: i })),
      decisions: decisions.map((d, i) => ({ ...d, order: i })),
      actionItems,
      origin: 'ai',
    };
  }

  /** Prompt 组装：明确要求只输出 JSON，并强调 id 必须来自给定发言 */
  private buildPrompt(
    title: string,
    participants: Participant[],
    chunk: Utterance[],
    partIndex: number,
    partTotal: number,
  ): string {
    const names = participants
      .filter((p) => p.id !== UNKNOWN_SPEAKER_ID)
      .map((p) => p.name)
      .join('、');
    const head = [
      '你是会议纪要助手。下面是会议「' + title + '」的第 ' + partIndex + '/' + partTotal + ' 段发言记录。',
      '参会人：' + (names || '未知'),
      '请输出严格 JSON（不要解释、不要用代码块），结构如下：',
      '{"topics":[{"title":"","summary":"","bullets":[""],"startUtteranceId":"","endUtteranceId":""}],',
      '"decisions":[{"content":"","sourceUtteranceIds":[""]}],',
      '"actionItems":[{"content":"","assigneeName":"","dueDate":"YYYY-MM-DD","priority":"P0|P1|P2","sourceUtteranceIds":[""]}]}',
      '规则：',
      '1) sourceUtteranceIds 只能填下面发言记录中方括号里的 id，找不到就留空数组，禁止编造 id；',
      '2) dueDate 只填 YYYY-MM-DD，无法判断留空字符串；',
      '3) assigneeName 必须是参会人之一，无法判断留空字符串；',
      '4) 决议只保留已确定的结论，待办只保留明确要执行的事项；',
      '5) 议题按讨论顺序切分，每段 1 句话 summary + 3 条以内 bullets。',
      '发言记录：',
    ].join('\n');
    return `${head}\n${renderUtterances(chunk, participants)}`;
  }

  /** 调用模型：首选入口失败 → 换默认模型重试（三级自愈第 ② 级） */
  private async callModel(prompt: string): Promise<string> {
    try {
      return await this.invoke(this.model, prompt);
    } catch (e) {
      if (this.modelName !== DEFAULT_MODEL) {
        const fallback = await cloudbaseClient.getAiModel(DEFAULT_MODEL);
        if (fallback) {
          this.model = fallback as AiModelLike;
          this.modelName = DEFAULT_MODEL;
          return await this.invoke(this.model, prompt);
        }
      }
      throw e;
    }
  }

  /** 实际发起一次请求（兼容 generateText / chat 两种 SDK 形态） */
  private async invoke(model: AiModelLike, prompt: string): Promise<string> {
    const messages = [
      { role: 'system', content: '你是严谨的会议纪要助手，只输出合法 JSON。' },
      { role: 'user', content: prompt },
    ];
    if (typeof model.generateText === 'function') {
      return pickText(await model.generateText({ model: this.modelName, messages }));
    }
    if (typeof model.chat === 'function') {
      return pickText(await model.chat({ model: this.modelName, messages }));
    }
    throw new Error('AI 模型句柄不支持 generateText/chat');
  }

  /** 把 AI 结果对齐到真实实体：id 对不上丢弃，负责人按姓名匹配，绝不编造 */
  private align(
    raw: RawResult,
    meetingId: string,
    participants: Participant[],
    validIds: Set<string>,
  ): StructResult {
    const keep = (ids: unknown): string[] =>
      (Array.isArray(ids) ? ids : [])
        .filter((x): x is string => typeof x === 'string')
        .filter((id) => validIds.has(id));

    const topics: Omit<Topic, 'createdAt'>[] = (raw.topics ?? [])
      .filter((t) => typeof t?.title === 'string' && t.title.trim().length > 0)
      .map((t, i) => ({
        id: newId(),
        meetingId,
        order: i,
        title: String(t.title).trim(),
        summary: typeof t.summary === 'string' ? t.summary.trim() : '',
        bullets: Array.isArray(t.bullets) ? t.bullets.filter((b): b is string => typeof b === 'string') : [],
        startUtteranceId: validIds.has(String(t.startUtteranceId)) ? String(t.startUtteranceId) : undefined,
        endUtteranceId: validIds.has(String(t.endUtteranceId)) ? String(t.endUtteranceId) : undefined,
        origin: 'ai' as const,
      }));

    const decisions: Omit<Decision, 'createdAt'>[] = (raw.decisions ?? [])
      .filter((d) => typeof d?.content === 'string' && d.content.trim().length > 0)
      .map((d, i) => ({
        id: newId(),
        meetingId,
        content: String(d.content).trim(),
        sourceUtteranceIds: keep(d.sourceUtteranceIds),
        order: i,
        confirmed: false,
        origin: 'ai' as const,
      }));

    const actionItems: Omit<ActionItem, 'createdAt'>[] = (raw.actionItems ?? [])
      .filter((a) => typeof a?.content === 'string' && a.content.trim().length > 0)
      .map((a) => {
        const assigneeName = typeof a.assigneeName === 'string' ? a.assigneeName.trim() : '';
        const assignee = assigneeName
          ? participants.find((p) => p.id !== UNKNOWN_SPEAKER_ID && p.name === assigneeName) ?? null
          : null;
        const dueDate = typeof a.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.dueDate) ? a.dueDate : null;
        const priority: ActionPriority =
          a.priority === 'P0' || a.priority === 'P1' ? (a.priority as ActionPriority) : dueDate ? 'P1' : 'P2';
        return {
          id: newId(),
          meetingId,
          content: String(a.content).trim(),
          assigneeId: assignee?.id ?? null,
          dueDate,
          priority,
          status: 'todo' as const,
          sourceUtteranceIds: keep(a.sourceUtteranceIds),
          origin: 'ai' as const,
        };
      });

    return { topics, decisions, actionItems, origin: 'ai' };
  }
}
