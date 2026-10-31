import type { ActionItem, Decision, Meeting, MeetingSnapshot, Participant, Topic, Utterance } from '@/types/models';
import { SCHEMA_VERSION, UNKNOWN_SPEAKER_ID } from '@/types/models';
import {
  copyText,
  downloadFile,
  escapeHtml,
  escapeMd,
  fmtDate,
  fmtDateTime,
  fmtDurCN,
  hhmmss,
  relDueDateCN,
  safeFileName,
} from '@/lib/utils';
import { renderPrintHtml } from './toPrintHtml';
import { toast } from '@/stores/useUiStore';

/** 支持的导出格式 */
export type ExportFormat = 'md' | 'txt' | 'json' | 'html';

/** 待办清单文本风格 */
export type ActionListStyle = 'md' | 'txt' | 'tsv';

/** 导出产物 */
export interface ExportPayload {
  content: string;
  ext: string;
  mime: string;
  fileName: string;
}

const MIMES: Record<ExportFormat, string> = {
  md: 'text/markdown;charset=utf-8',
  txt: 'text/plain;charset=utf-8',
  json: 'application/json;charset=utf-8',
  html: 'text/html;charset=utf-8',
};

/** Markdown 表格单元格安全化：先把管道符替换为全角（避免撑破表格列），再做通用转义 */
function mdCell(s: string): string {
  return escapeMd(String(s ?? '').replace(/\|/g, '｜'));
}

/** 参会人展示名（排除系统保留的「未知发言人」） */
export function realParticipants(participants: Participant[]): Participant[] {
  return participants.filter((p) => p.id !== UNKNOWN_SPEAKER_ID);
}

export function speakerNameOf(participants: Participant[], id: string | null | undefined): string {
  if (!id) return '未知发言人';
  return participants.find((p) => p.id === id)?.name ?? '未知发言人';
}

/** 取条目对应的时间码（首条溯源发言的 startMs） */
export function timecodeOf(utterances: Utterance[], ids: string[]): string {
  for (const id of ids) {
    const u = utterances.find((x) => x.id === id);
    if (u) return hhmmss(u.startMs);
  }
  return '--:--:--';
}

/** 会议头信息（四种格式共用，保证内容一致） */
function headerLines(s: MeetingSnapshot): { time: string; people: string; count: string; duration: string } {
  const { meeting, participants, utterances } = s;
  const start = fmtDateTime(meeting.startedAt);
  const end = meeting.endedAt ? fmtDateTime(meeting.endedAt) : '进行中';
  return {
    time: `${start} – ${end}（${fmtDurCN(meeting.durationMs || 0)}）`,
    people: realParticipants(participants).map((p) => p.name).join('、') || '未记录',
    count: String(utterances.length),
    duration: fmtDurCN(meeting.durationMs || 0),
  };
}

/* ============================ Markdown ============================ */

/**
 * Markdown 序列化（PRD §7.4 结构）。
 * 所有用户输入都走 escapeMd()，避免原文里的 # * | 破坏表格与标题。
 */
export function toMarkdown(s: MeetingSnapshot): string {
  const { meeting, participants, utterances, topics, decisions, actionItems } = s;
  const h = headerLines(s);
  const L: string[] = [];

  L.push(`# ${escapeMd(meeting.title)}`, '');
  L.push(`> **时间**：${h.time}`);
  L.push(`> **参会人**：${escapeMd(h.people)}`);
  L.push(`> **发言条数**：${h.count}`, '');

  if (topics.length > 0) {
    topics.forEach((t, i) => {
      L.push(`## 议题 ${i + 1} · ${escapeMd(t.title)}`, '');
      if (t.summary) L.push(`> ${escapeMd(t.summary)}`, '');
      for (const b of t.bullets) L.push(`- ${escapeMd(b)}`);
      L.push('');
    });
  }

  L.push('## ✅ 决议', '');
  if (decisions.length === 0) {
    L.push('（无）', '');
  } else {
    decisions.forEach((d, i) => {
      const tc = timecodeOf(utterances, d.sourceUtteranceIds);
      L.push(`${i + 1}. ${escapeMd(d.content)}　\`${tc}\``);
    });
    L.push('');
  }

  L.push('## 📋 待办事项', '');
  if (actionItems.length === 0) {
    L.push('（无）', '');
  } else {
    L.push('| 内容 | 负责人 | 截止 | 优先级 |');
    L.push('| --- | --- | --- | --- |');
    for (const a of actionItems) {
      const owner = mdCell(speakerNameOf(participants, a.assigneeId));
      const due = a.dueDate ? mdCell(`${a.dueDate}（${relDueDateCN(a.dueDate)}）`) : '—';
      L.push(`| ${mdCell(a.content)} | ${owner} | ${due} | ${a.priority} |`);
    }
    L.push('');
  }

  L.push('## 📝 附录：完整发言记录', '');
  if (utterances.length === 0) {
    L.push('（无）', '');
  } else {
    for (const u of utterances) {
      L.push(`[${hhmmss(u.startMs)}] ${escapeMd(speakerNameOf(participants, u.speakerId))}：${escapeMd(u.text)}`);
    }
    L.push('');
  }
  return L.join('\n');
}

/* ============================ 纯文本 ============================ */

/** 纯文本序列化（内容与 Markdown 一致，只是去掉标记语法） */
export function toPlainText(s: MeetingSnapshot): string {
  const { meeting, participants, utterances, topics, decisions, actionItems } = s;
  const h = headerLines(s);
  const L: string[] = [];

  L.push(meeting.title, '='.repeat(Math.min(60, meeting.title.length * 2)), '');
  L.push(`时间：${h.time}`);
  L.push(`参会人：${h.people}`);
  L.push(`发言条数：${h.count}`, '');

  if (topics.length > 0) {
    L.push('【议题】');
    topics.forEach((t, i) => {
      L.push(`  ${i + 1}. ${t.title}`);
      if (t.summary) L.push(`     摘要：${t.summary}`);
      for (const b of t.bullets) L.push(`     - ${b}`);
    });
    L.push('');
  }

  L.push('【决议】');
  if (decisions.length === 0) {
    L.push('  （无）');
  } else {
    decisions.forEach((d, i) => {
      L.push(`  ${i + 1}. [${timecodeOf(utterances, d.sourceUtteranceIds)}] ${d.content}`);
    });
  }
  L.push('');

  L.push('【待办事项】');
  if (actionItems.length === 0) {
    L.push('  （无）');
  } else {
    actionItems.forEach((a, i) => {
      const owner = speakerNameOf(participants, a.assigneeId);
      const due = a.dueDate ? escapeMd(`${a.dueDate}（${relDueDateCN(a.dueDate)}）`) : '—';
      L.push(`  ${i + 1}. ${a.content}`);
      L.push(`     负责人：${owner}    截止：${due}    优先级：${a.priority}`);
    });
  }
  L.push('');

  L.push('【完整发言记录】');
  for (const u of utterances) {
    L.push(`  [${hhmmss(u.startMs)}] ${speakerNameOf(participants, u.speakerId)}：${u.text}`);
  }
  L.push('');
  return L.join('\n');
}

/* ============================ JSON ============================ */

/** JSON 序列化：完整 MeetingSnapshot，可被重新导入 */
export function toJson(s: MeetingSnapshot): string {
  return JSON.stringify({ ...s, schemaVersion: SCHEMA_VERSION, exportedAt: Date.now() }, null, 2);
}

/** 校验导入的 JSON 是否为本产品快照 */
export function parseSnapshotJson(text: string): MeetingSnapshot | null {
  try {
    const obj = JSON.parse(text) as Partial<MeetingSnapshot>;
    if (!obj || typeof obj !== 'object') return null;
    if (!obj.meeting || !Array.isArray(obj.utterances)) return null;
    // meeting 必须是非数组对象且含必要字段，否则视为脏数据拒绝导入
    const mtg = obj.meeting as unknown as Record<string, unknown>;
    if (typeof mtg !== 'object' || mtg === null || Array.isArray(mtg)) return null;
    if (typeof mtg.id !== 'string') return null;
    return {
      schemaVersion: typeof obj.schemaVersion === 'number' ? obj.schemaVersion : SCHEMA_VERSION,
      exportedAt: typeof obj.exportedAt === 'number' ? obj.exportedAt : Date.now(),
      meeting: obj.meeting,
      participants: Array.isArray(obj.participants) ? obj.participants : [],
      utterances: obj.utterances,
      topics: Array.isArray(obj.topics) ? obj.topics : [],
      decisions: Array.isArray(obj.decisions) ? obj.decisions : [],
      actionItems: Array.isArray(obj.actionItems) ? obj.actionItems : [],
    };
  } catch {
    return null;
  }
}

/* ============================ 文件名 / 编排 ============================ */

/** 文件名：`标题_YYYYMMDD.ext`（经 safeFileName 清洗） */
export function buildFileName(meeting: Meeting, ext: string): string {
  const d = new Date(meeting.startedAt || Date.now());
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const title = safeFileName(meeting.title) || 'meeting';
  return `${safeFileName(`${title}_${stamp}`)}.${ext}`;
}

/** 生成导出产物（唯一数据源：snapshot） */
export function exportSnapshot(s: MeetingSnapshot, format: ExportFormat): ExportPayload {
  let content = '';
  let ext = format;
  switch (format) {
    case 'md':
      content = toMarkdown(s);
      break;
    case 'txt':
      content = toPlainText(s);
      break;
    case 'json':
      content = toJson(s);
      break;
    case 'html':
      content = renderPrintHtml(s);
      break;
    default:
      content = toMarkdown(s);
      ext = 'md';
      break;
  }
  return { content, ext, mime: MIMES[format] ?? 'text/plain;charset=utf-8', fileName: buildFileName(s.meeting, ext) };
}

/** 触发一次导出下载（含成功 toast 与失败兜底） */
export function downloadExport(s: MeetingSnapshot, format: ExportFormat): void {
  try {
    const p = exportSnapshot(s, format);
    downloadFile(p.content, p.fileName, p.mime);
    toast.success(`已导出 ${p.fileName}`);
  } catch {
    toast.error('导出失败，请重试或改用其他格式');
  }
}

/* ============================ 待办清单（P1-10） ============================ */

/** 排序：未完成 → 优先级 → 截止日期 → 创建顺序 */
export function sortActionItems(items: ActionItem[]): ActionItem[] {
  const pw: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
  return [...items].sort((a, b) => {
    const sa = a.status === 'done' ? 1 : 0;
    const sb = b.status === 'done' ? 1 : 0;
    if (sa !== sb) return sa - sb;
    const pa = pw[a.priority] ?? 2;
    const pb = pw[b.priority] ?? 2;
    if (pa !== pb) return pa - pb;
    const da = a.dueDate ?? '9999-99-99';
    const db = b.dueDate ?? '9999-99-99';
    if (da !== db) return da < db ? -1 : 1;
    return a.createdAt - b.createdAt;
  });
}

/** 待办清单文本：md（表格）/ txt（可读）/ tsv（可直接粘进 Excel） */
export function buildActionListText(s: MeetingSnapshot, style: ActionListStyle = 'md'): string {
  const items = sortActionItems(s.actionItems);
  const owner = (id: string | null | undefined): string => speakerNameOf(s.participants, id);
  if (style === 'tsv') {
    const rows = ['内容\t负责人\t截止\t优先级\t状态\t来源'];
    for (const a of items) {
      rows.push(
        [
          a.content.replace(/[\t\r\n]/g, ' '),
          owner(a.assigneeId),
          a.dueDate ?? '',
          a.priority,
          a.status === 'done' ? '已完成' : '未完成',
          s.meeting.title,
        ].join('\t'),
      );
    }
    return rows.join('\n');
  }
  if (style === 'txt') {
    const L = [`待办清单 · ${s.meeting.title}（${fmtDate(s.meeting.startedAt)}）`, ''];
    items.forEach((a, i) => {
      const due = a.dueDate ? `${a.dueDate}（${relDueDateCN(a.dueDate)}）` : '未设截止';
      L.push(`${i + 1}. [${a.status === 'done' ? 'x' : ' '}] ${a.content}`);
      L.push(`   负责人：${owner(a.assigneeId)}    截止：${due}    优先级：${a.priority}`);
    });
    return L.join('\n');
  }
  const L = ['| 内容 | 负责人 | 截止 | 优先级 | 状态 |', '| --- | --- | --- | --- | --- |'];
  for (const a of items) {
    const due = a.dueDate ? `${escapeMd(a.dueDate)}（${relDueDateCN(a.dueDate)}）` : '—';
    L.push(
      `| ${escapeMd(a.content)} | ${escapeMd(owner(a.assigneeId))} | ${due} | ${a.priority} | ${
        a.status === 'done' ? '已完成' : '未完成'
      } |`,
    );
  }
  return L.join('\n');
}

/** 一键复制待办清单到剪贴板（失败时提示手动复制） */
export async function copyActionList(s: MeetingSnapshot, style: ActionListStyle = 'md'): Promise<boolean> {
  const text = buildActionListText(s, style);
  const ok = await copyText(text);
  if (ok) toast.success('待办清单已复制到剪贴板');
  else toast.warning('当前环境不支持剪贴板，请改用导出');
  return ok;
}

/* ============================ 打印 ============================ */

/** 在新窗口打开打印友好 HTML 并唤起打印对话框 */
export function openPrintWindow(s: MeetingSnapshot): void {
  try {
    const w = window.open('', '_blank', 'noopener,width=960,height=1200');
    if (!w) {
      toast.warning('浏览器拦截了新窗口，请改用导出 HTML 后打印');
      return;
    }
    w.document.open();
    w.document.write(renderPrintHtml(s));
    w.document.close();
    w.focus();
    window.setTimeout(() => {
      try {
        w.print();
      } catch {
        /* 用户可自行 Ctrl+P */
      }
    }, 400);
  } catch {
    toast.error('导出失败，请重试或改用其他格式');
  }
}

/** 导出 HTML（供下载） */
export function toHtml(s: MeetingSnapshot): string {
  return renderPrintHtml(s);
}

/** 供 UI 直接使用的类型再导出，避免页面各自拼装 */
export type { MeetingSnapshot, Topic, Decision, ActionItem, Utterance, Meeting };
export { escapeHtml };
