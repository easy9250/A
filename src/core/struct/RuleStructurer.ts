import type { ActionItem, ActionPriority, Decision, Meeting, Participant, Topic, Utterance } from '@/types/models';
import { UNKNOWN_SPEAKER_ID } from '@/types/models';
import type { IStructurer, StructInput, StructResult } from './index';
import { newId } from '@/lib/utils';

/* ============================================================
 * 本地规则引擎 —— 无云场景下的「主路径」
 * 设计原则：宁可少抽，不可错抽；不猜人、不编造日期。
 * ============================================================ */

/** 议题分段：相邻发言间隔阈值 */
const TOPIC_GAP_MS = 90_000;
/** 命中切换词后，距本段起点的最小间隔（避免连续切词把每段切碎） */
const TOPIC_MIN_SPAN_MS = 20_000;
/** 段名取首句前 N 字 */
const TOPIC_TITLE_LEN = 12;
/** 每段要点条数 */
const BULLET_COUNT = 3;
/** 单条要点最大字数 */
const BULLET_MAX_LEN = 40;

/** 话题切换词 */
const TOPIC_SWITCH_RE = /^(接下来|下面|我们看一下|看一下|下一个|然后|关于|换个话题|第二|其次|最后|另外|再来看|回头看|顺便)/;
/** 决议句式（「确认了」单模式已移除：易把「确认了某个事实」误判为决议） */
const DECISION_RE = /(决定|决议|就按|定为|拍板|一致同意|确认采用|敲定|那就这样|就这么定|同意采用|采用方案|通过|达成一致)/;
/** 未落定表述（命中则不作为决议，如「由王总决定」「先不动」） */
const UNSETTLED_RE = /(先不动|先不|还没|尚未|暂时|再议|待定|回头|先看看|由.+决定|由.+拍板|等.+决定|谁决定|不清楚|不确定|再说|未定|还没定)/;
/** 疑问标记（命中则不作为决议） */
const QUESTION_RE = /[?？]|吗|是否|要不要|好不好|能不能|行不行|怎么样|如何/;
/** 待办句式 A：责任前缀 */
const ACTION_PREFIX_RE = /(我来|我负责|我跟进|我来负责|我这边|你去|你负责|麻烦你|谁负责|安排一下|记得|需要有人|我们来)/;
/** 待办句式 B：时间/截止线索 */
const DEADLINE_RE = /(今天|今晚|今日|明天|明早|后天|大后天|本周|这周|下周|周[一二三四五六日天1-6]|星期[一二三四五六日天]|下个月|月底|截止|之前|前完成|以内|DDL|deadline)/i;
/** 动作动词（句式 A/B 都要求命中至少一个） */
const ACTION_VERB_RE = /(跟进|推动|落实|做|改|写|发|提交|整理|对接|确认|准备|安排|处理|完成|上线|测试|评审|同步|沟通|修复|优化|补充|输出|汇总|拉|约|排|统计|调研|设计|开发|验证|复盘|输出一版|给到|发出来|过一遍)/;
/** 完成态标记 A：已发生类副词（单独出现不足以判定，需配合 B） */
const COMPLETED_MARKER_A = /(已经|已|提前|先前|刚刚|刚)/;
/** 完成态标记 B：完成尾词 */
const COMPLETED_TAIL = /(了|过|完成|好了|完了|出来|出来了)/;
/** 会议"元话语"（在说记录/纪要本身，不是真正的决议） */
const META_TALK_RE = /(记一下|记下来|记录一下|记到|纪要|总结一下|整理一下纪要)/;
/** 紧急词 → P0 */
const URGENT_RE = /(尽快|今天|今晚|今日|马上|立刻|紧急|优先|上线前|越快越好)/;
/** 负责人识别：姓名 + 责任动词 */
const ASSIGN_SUFFIX = '(?:来|负责|跟进|做|处理|对接|确认|安排|补充|准备|输出|统计|拉|约)';

/** 转义正则元字符 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 归一化：去标点空白，用于去重判等 */
function normalize(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 去语气词前缀，反复剥离直到稳定 */
function stripFiller(text: string): string {
  let out = text.trim();
  const fillers = /^(那|那么|然后|就是|好吧|好的|嗯|啊|哦|这个|那个|所以|另外|接下来|下面|我们|我觉得|我认为|我建议|大家|其实|反正|这样吧)/;
  for (let i = 0; i < 4; i += 1) {
    const next = out.replace(fillers, '').replace(/^[，、,,:：；;。.\s]+/, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

/** 决议正文清洗：去掉「那/我们/我觉得」等前缀与尾随口语 */
function cleanDecisionText(text: string): string {
  let out = stripFiller(text);
  out = out.replace(/^我(?=决定|确认|同意|建议|拍板)/, '');
  out = out.replace(/^(那就|那我们|我们就|我们就这么|好的那)/, '');
  out = out.replace(/(吧|呢|啊|哦|嗯)$/, '');
  out = out.replace(/[。.．]+$/, '');
  return out.trim();
}

/** 待办正文清洗：去掉主语（我/你/大家/谁 + 助动词），保留谓宾结构 */
function cleanActionText(text: string): string {
  let out = stripFiller(text);
  // 去掉开头的 @提及 与「麻烦/请」，保留真正的谓宾结构
  out = out.replace(/^@[^\s，。,;；:：、]+\s*/, '');
  out = out.replace(/^(?:麻烦|请)/, '');
  out = out.replace(/^(我|我们|你|你们|大家|谁|他|她)(来|去|负责|会|要|得|记得|帮忙|尽快|明天|今天|马上)?/, '');
  out = out.replace(/(吧|呢|啊|哦|嗯|哈)$/, '');
  out = out.replace(/[。.．]+$/, '');
  return out.trim();
}

/** 压缩到 max 字，超长补省略号 */
function ellipsis(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 本地日期 → 'YYYY-MM-DD' */
function toDateStr(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 取某天 00:00 */
function startOfDay(ms: number): Date {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** 加天数 */
function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + n);
  return out;
}

/** 中文星期 → getDay() 数值（0=周日） */
const WEEKDAY_MAP: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0,
  1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6,
};

/**
 * 相对日期解析 → 'YYYY-MM-DD'；解析不出返回 null（绝不猜）。
 * 基准：meeting.startedAt 的本地时区。
 */
export function parseDueDate(text: string, baseMs: number): string | null {
  const t = text.replace(/\s+/g, '');
  const base = startOfDay(baseMs);
  const dow = base.getDay(); // 0=周日

  /* ① 具体日期：11月3号 / 11月3日 / 11-03 / 11/3（绝不编造：区间/百分比/不存在的日期一律返回 null） */
  const mdMonth = /(\d{1,2})月(\d{1,3})[号日]?/.exec(t);
  let month: number | null = null;
  let day: number | null = null;
  if (mdMonth) {
    month = Number(mdMonth[1]);
    day = Number(mdMonth[2]);
  } else {
    const mdDash = /(\d{1,2})[-/](\d{1,2})(?!\d)/.exec(t);
    if (mdDash) {
      // 排除口语里的区间 / 百分比 / 版本号：「2-3 周」「10-12%」「1.2-1.5 版本」
      const tail = t.slice(mdDash.index + mdDash[0].length);
      if (!/(周|天|个月|个星期|%|％|个百分点|倍|版本)/.test(tail)) {
        month = Number(mdDash[1]);
        day = Number(mdDash[2]);
      }
    }
  }
  if (month !== null && day !== null && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
    const now = new Date(baseMs);
    let year = now.getFullYear();
    const candidate = new Date(year, month - 1, day);
    if (candidate.getTime() + 180 * 86400000 < base.getTime()) year += 1;
    // 校验该日期真实存在：2月30号之类会溢出到下月，必须拒绝（绝不猜、不溢出）
    const verified = new Date(year, month - 1, day);
    if (verified.getMonth() === month - 1 && verified.getDate() === day) {
      return toDateStr(verified);
    }
    return null;
  }

  /* ② 下下周 X / 下周 X */
  let m = /下下(?:周|星期)([一二三四五六日天1-6])/.exec(t);
  if (m) {
    const target = WEEKDAY_MAP[m[1]] ?? 1;
    const mondayOffset = dow === 0 ? 1 : 8 - dow; // 下周一相对今天的偏移（周从周一起）
    const nextMonday = addDays(base, mondayOffset + 7);
    const delta = (target - 1 + 7) % 7;
    return toDateStr(addDays(nextMonday, delta));
  }
  m = /下(?:周|星期)([一二三四五六日天1-6])/.exec(t);
  if (m) {
    const target = WEEKDAY_MAP[m[1]] ?? 1;
    const mondayOffset = dow === 0 ? 1 : 8 - dow;
    const nextMonday = addDays(base, mondayOffset);
    const delta = (target - 1 + 7) % 7;
    return toDateStr(addDays(nextMonday, delta));
  }

  /* ③ 周 X / 星期 X（按「本周/下周」修饰语判定取哪一周；无修饰默认取下一个该星期几） */
  m = /(?:周|星期)([一二三四五六日天1-6])/.exec(t);
  if (m) {
    const target = WEEKDAY_MAP[m[1]] ?? 1;
    const isThisWeek = /本周|这周|这星期/.test(t);
    const isNextWeek = /下周|下星期|下个周/.test(t);
    let delta = (target - dow + 7) % 7;
    if (delta === 0) {
      if (isNextWeek) delta = 7;
      else if (isThisWeek) delta = 0;
      else delta = 7; // 无修饰：默认取下一个该星期几
    }
    return toDateStr(addDays(base, delta));
  }

  /* ④ 相对天数 */
  if (/大后天/.test(t)) return toDateStr(addDays(base, 3));
  if (/后天/.test(t)) return toDateStr(addDays(base, 2));
  if (/明天|明早|明日/.test(t)) return toDateStr(addDays(base, 1));
  if (/今天|今晚|今日|当日/.test(t)) return toDateStr(base);

  /* ⑤ 周粒度：下周 / 下星期 → 下周日；本周 / 这周 → 本周日；月底 → 当月最后一天 */
  if (/下周|下星期|下个周/.test(t)) {
    const daysToSunday = dow === 0 ? 7 : 7 - dow;
    return toDateStr(addDays(base, daysToSunday + 7));
  }
  if (/本周|这周|这星期/.test(t)) {
    const daysToSunday = dow === 0 ? 0 : 7 - dow;
    return toDateStr(addDays(base, daysToSunday));
  }
  if (/月底|月末/.test(t)) {
    const d = new Date(base.getFullYear(), base.getMonth() + 1, 0);
    return toDateStr(d);
  }
  return null;
}

/** 在参会人名单里按片段匹配（优先长名，避免「王」误命中「王强」） */
function matchParticipant(fragment: string, participants: Participant[]): Participant | null {
  const frag = fragment.trim();
  if (!frag) return null;
  const real = participants
    .filter((p) => p.id !== UNKNOWN_SPEAKER_ID && p.name)
    .sort((a, b) => b.name.length - a.name.length);
  for (const p of real) if (p.name === frag) return p;
  for (const p of real) if (frag.startsWith(p.name) || p.name.startsWith(frag)) return p;
  return null;
}

/**
 * 负责人识别（绝不猜人）：
 * ① 句中 `@姓名` 精确匹配参会人；
 * ② 句首 `我来/我负责/我跟进` → 取该条发言的 speakerId；
 * ③ `姓名 + 责任动词`（如「李娜跟进」）→ 该参会人；
 * ④ 其余留空（导出显示 `—`）。
 */
export function resolveAssignee(
  text: string,
  participants: Participant[],
  speakerId: string | null,
): string | null {
  const at = /@([^\s，。,;；:：、]+)/.exec(text);
  if (at) {
    const p = matchParticipant(at[1], participants);
    if (p) return p.id;
  }
  const sText = stripFiller(text);
  if (/^(我来|我负责|我跟进|我来负责|我这边|我一会儿|我待会)/.test(sText)) {
    if (speakerId && speakerId !== UNKNOWN_SPEAKER_ID) return speakerId;
  }
  for (const p of [...participants].sort((a, b) => b.name.length - a.name.length)) {
    if (p.id === UNKNOWN_SPEAKER_ID || p.name.length < 2) continue;
    const re = new RegExp(`${escapeRegExp(p.name)}${ASSIGN_SUFFIX}`);
    if (re.test(text)) return p.id;
  }
  return null;
}

/** 优先级判定 */
export function resolvePriority(text: string, dueDate: string | null): ActionPriority {
  if (URGENT_RE.test(text)) return 'P0';
  if (dueDate) return 'P1';
  return 'P2';
}

/**
 * 本地规则引擎。
 * 分段 → 要点 → 决议 → 待办，逐阶段通过 onPartial 回吐，UI 可渐进渲染。
 */
export class RuleStructurer implements IStructurer {
  readonly kind = 'rule' as const;

  async structure(input: StructInput, onPartial?: (p: Partial<StructResult>) => void): Promise<StructResult> {
    const { meeting, participants, utterances } = input;
    const utts = [...utterances].sort((a, b) => a.seq - b.seq);

    const topics = this.buildTopics(meeting, utts);
    onPartial?.({ topics });

    const decisions = this.extractDecisions(meeting, utts);
    onPartial?.({ topics, decisions });

    const actionItems = this.extractActions(meeting, participants, utts);
    onPartial?.({ topics, decisions, actionItems });

    return { topics, decisions, actionItems, origin: 'rule' };
  }

  /** 议题预分段：间隔 ≥90s 或 命中切换词且距段首 ≥20s */
  private buildTopics(meeting: Meeting, utts: Utterance[]): Omit<Topic, 'createdAt'>[] {
    if (utts.length === 0) return [];
    const segments: Utterance[][] = [];
    let cur: Utterance[] = [];
    let segStart = 0;
    let lastEnd = 0;

    for (const u of utts) {
      if (cur.length === 0) {
        cur = [u];
        segStart = u.startMs;
        lastEnd = u.endMs;
        continue;
      }
      const gap = u.startMs - lastEnd;
      const switched = TOPIC_SWITCH_RE.test(u.text.trim()) && u.startMs - segStart >= TOPIC_MIN_SPAN_MS;
      if (gap >= TOPIC_GAP_MS || switched) {
        segments.push(cur);
        cur = [u];
        segStart = u.startMs;
      } else {
        cur.push(u);
      }
      lastEnd = Math.max(lastEnd, u.endMs);
    }
    if (cur.length > 0) segments.push(cur);

    return segments.map((seg, i) => {
      const first = seg[0];
      const last = seg[seg.length - 1];
      const rawTitle = stripFiller(first.text) || first.text;
      const title = ellipsis(rawTitle, TOPIC_TITLE_LEN);
      const bullets = [...seg]
        .sort((a, b) => b.text.length - a.text.length)
        .slice(0, BULLET_COUNT)
        .map((u) => ellipsis(stripFiller(u.text), BULLET_MAX_LEN))
        .filter((s) => s.length > 0);
      const summary = bullets[0] ?? '';
      return {
        id: newId(),
        meetingId: meeting.id,
        order: i,
        title: title || `议题 ${i + 1}`,
        summary,
        bullets: Array.from(new Set(bullets)),
        startUtteranceId: first.id,
        endUtteranceId: last.id,
        origin: 'rule' as const,
      };
    });
  }

  /** 决议抽取：命中决议句式且非疑问 */
  private extractDecisions(meeting: Meeting, utts: Utterance[]): Omit<Decision, 'createdAt'>[] {
    const out: Omit<Decision, 'createdAt'>[] = [];
    const seen = new Map<string, Omit<Decision, 'createdAt'>>();
    for (const u of utts) {
      const text = u.text.trim();
      if (!text) continue;
      if (QUESTION_RE.test(text)) continue;
      if (!DECISION_RE.test(text)) continue;
      // 排除"把决议记下来"这类元话语
      if (META_TALK_RE.test(text)) continue;
      // 排除"决定权在别处 / 尚未落定"的表述（如「由王总决定，我们先不动」）
      if (UNSETTLED_RE.test(text)) continue;
      const content = cleanDecisionText(text);
      if (content.length < 4) continue;

      const key = normalize(content).slice(0, 12);
      const exist = seen.get(key);
      if (exist) {
        if (!exist.sourceUtteranceIds.includes(u.id)) exist.sourceUtteranceIds.push(u.id);
        continue;
      }
      const item: Omit<Decision, 'createdAt'> = {
        id: newId(),
        meetingId: meeting.id,
        content,
        sourceUtteranceIds: [u.id],
        order: out.length,
        confirmed: false,
        origin: 'rule',
      };
      seen.set(key, item);
      out.push(item);
    }
    return out;
  }

  /** 待办抽取：句式 A（责任前缀 + 动作动词）或句式 B（时间线索 + 动作动词） */
  private extractActions(
    meeting: Meeting,
    participants: Participant[],
    utts: Utterance[],
  ): Omit<ActionItem, 'createdAt'>[] {
    const out: Omit<ActionItem, 'createdAt'>[] = [];
    const seen = new Map<string, Omit<ActionItem, 'createdAt'>>();
    for (const u of utts) {
      const text = u.text.trim();
      if (!text) continue;
      if (QUESTION_RE.test(text)) continue;
      const hasVerb = ACTION_VERB_RE.test(text);
      if (!hasVerb) continue;
      const byPrefix = ACTION_PREFIX_RE.test(text);
      const byDeadline = DEADLINE_RE.test(text);
      if (!byPrefix && !byDeadline) continue;
      // 完成态排除：仅因时间线索（句式 B）命中、且带「已经/已/提前…+了/过」的已发生陈述，不抽待办
      if (!byPrefix && COMPLETED_MARKER_A.test(text) && COMPLETED_TAIL.test(text)) continue;

      const content = cleanActionText(text);
      if (content.length < 3) continue;
      const dueDate = parseDueDate(text, meeting.startedAt);
      const assigneeId = resolveAssignee(text, participants, u.speakerId);
      const priority = resolvePriority(text, dueDate);

      const key = normalize(content).slice(0, 12);
      const exist = seen.get(key);
      if (exist) {
        if (!exist.sourceUtteranceIds.includes(u.id)) exist.sourceUtteranceIds.push(u.id);
        // 后来者若带更明确的信息（负责人/截止），补齐前一条
        if (!exist.assigneeId && assigneeId) exist.assigneeId = assigneeId;
        if (!exist.dueDate && dueDate) exist.dueDate = dueDate;
        if (priority === 'P0' && exist.priority !== 'P0') exist.priority = 'P0';
        continue;
      }
      const item: Omit<ActionItem, 'createdAt'> = {
        id: newId(),
        meetingId: meeting.id,
        content,
        assigneeId,
        dueDate,
        priority,
        status: 'todo',
        sourceUtteranceIds: [u.id],
        origin: 'rule',
      };
      seen.set(key, item);
      out.push(item);
    }
    return out;
  }
}
