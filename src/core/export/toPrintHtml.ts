import type { MeetingSnapshot, Participant, Utterance } from '@/types/models';
import { UNKNOWN_SPEAKER_ID } from '@/types/models';
import { escapeHtml, fmtDateTime, fmtDurCN, hhmmss, relDueDateCN } from '@/lib/utils';

/**
 * 打印友好 HTML：内嵌 CSS + `@media print` A4 分页 + 隐藏交互元素。
 * 直接 `Ctrl/Cmd + P` 即可得到 A4 PDF；所有用户输入一律 escapeHtml()。
 */

/** 发言人展示名 */
function nameOf(participants: Participant[], id: string | null | undefined): string {
  if (!id) return '未知发言人';
  return participants.find((p) => p.id === id)?.name ?? '未知发言人';
}

/** 首条溯源发言的时间码 */
function tcOf(utterances: Utterance[], ids: string[]): string {
  for (const id of ids) {
    const u = utterances.find((x) => x.id === id);
    if (u) return hhmmss(u.startMs);
  }
  return '--:--:--';
}

/** 内嵌样式（屏幕预览 + 打印 A4 分页） */
const CSS = `
  :root { --brand:#1E3A8A; --accent:#2563EB; --line:#E5E7EB; --muted:#6B7280; }
  * { box-sizing: border-box; }
  body { margin:0; background:#F5F7FB; color:#1F2937;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",Arial,sans-serif;
    font-size:13px; line-height:1.6; }
  .page { width:210mm; min-height:297mm; margin:0 auto; background:#fff; padding:16mm 14mm; box-shadow:0 1px 6px rgba(15,23,42,.08); }
  h1 { font-size:22px; margin:0 0 6px; color:var(--brand); letter-spacing:.01em; }
  .meta { color:var(--muted); font-size:12px; margin-bottom:14px; }
  .meta span { margin-right:14px; }
  h2 { font-size:15px; margin:20px 0 8px; padding-bottom:5px; border-bottom:2px solid var(--accent); color:var(--brand); }
  h3 { font-size:13px; margin:12px 0 4px; color:#111827; }
  p { margin:5px 0; }
  ul { margin:5px 0 10px; padding-left:20px; }
  li { margin:3px 0; }
  table { width:100%; border-collapse:collapse; margin:8px 0 14px; font-size:12px; }
  th, td { border:1px solid var(--line); padding:6px 8px; text-align:left; vertical-align:top; }
  th { background:#EFF3FA; color:var(--brand); font-weight:600; }
  tr { page-break-inside:avoid; }
  .topic { page-break-inside:avoid; margin-bottom:12px; }
  .topic .title { font-weight:600; color:#111827; }
  .topic .summary { color:var(--muted); }
  .decision { margin:4px 0; padding-left:2px; page-break-inside:avoid; }
  .tc { color:var(--muted); font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11px; margin-right:6px; }
  .utt { display:flex; gap:8px; margin:2px 0; page-break-inside:avoid; }
  .utt .who { min-width:88px; font-weight:600; color:#374151; }
  .utt .txt { flex:1; white-space:pre-wrap; word-break:break-word; }
  .empty { color:var(--muted); font-style:italic; }
  .footer { margin-top:18px; padding-top:8px; border-top:1px solid var(--line); color:var(--muted); font-size:11px; }
  .badge { display:inline-block; padding:1px 6px; border-radius:4px; font-size:11px; font-weight:600; }
  .p0 { background:#FEE2E2; color:#B91C1C; } .p1 { background:#FEF3C7; color:#B45309; } .p2 { background:#E5E7EB; color:#4B5563; }
  @media print {
    @page { size:A4; margin:14mm 12mm; }
    body { background:#fff; }
    .page { width:auto; min-height:auto; margin:0; padding:0; box-shadow:none; }
    .no-print, .no-print * { display:none !important; }
    h2 { page-break-after:avoid; }
    .topic, .decision, .utt, tr { page-break-inside:avoid; }
  }
`;

/** 生成完整 HTML 文档字符串 */
export function renderPrintHtml(s: MeetingSnapshot): string {
  const { meeting, participants, utterances, topics, decisions, actionItems } = s;
  const people = participants
    .filter((p) => p.id !== UNKNOWN_SPEAKER_ID)
    .map((p) => escapeHtml(p.name))
    .join('、') || '未记录';

  const endText = meeting.endedAt ? fmtDateTime(meeting.endedAt) : '进行中';
  const dur = fmtDurCN(meeting.durationMs || 0);

  const topicHtml =
    topics.length === 0
      ? '<p class="empty">（无议题分段）</p>'
      : topics
          .map(
            (t) => `<div class="topic">
      <div class="title">${escapeHtml(String(topics.indexOf(t) + 1))}. ${escapeHtml(t.title)}</div>
      ${t.summary ? `<div class="summary">${escapeHtml(t.summary)}</div>` : ''}
      ${t.bullets.length > 0 ? `<ul>${t.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>` : ''}
    </div>`,
          )
          .join('');

  const decisionHtml =
    decisions.length === 0
      ? '<p class="empty">（无）</p>'
      : decisions
          .map(
            (d, i) => `<div class="decision">${i + 1}. ${escapeHtml(d.content)}
      <span class="tc">${tcOf(utterances, d.sourceUtteranceIds)}</span></div>`,
          )
          .join('');

  const actionRows =
    actionItems.length === 0
      ? '<tr><td colspan="5" class="empty">（无）</td></tr>'
      : actionItems
          .map((a) => {
            const due = a.dueDate ? `${escapeHtml(a.dueDate)}（${escapeHtml(relDueDateCN(a.dueDate))}）` : '—';
            const cls = a.priority === 'P0' ? 'p0' : a.priority === 'P1' ? 'p1' : 'p2';
            return `<tr>
        <td>${escapeHtml(a.content)}</td>
        <td>${escapeHtml(nameOf(participants, a.assigneeId))}</td>
        <td>${due}</td>
        <td><span class="badge ${cls}">${a.priority}</span></td>
        <td>${a.status === 'done' ? '已完成' : '未完成'}</td>
      </tr>`;
          })
          .join('');

  const uttHtml =
    utterances.length === 0
      ? '<p class="empty">（无）</p>'
      : utterances
          .map(
            (u) => `<div class="utt"><span class="tc">[${hhmmss(u.startMs)}]</span>
      <span class="who">${escapeHtml(nameOf(participants, u.speakerId))}</span>
      <span class="txt">${escapeHtml(u.text)}</span></div>`,
          )
          .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(meeting.title)} · 会议纪要</title>
<style>${CSS}</style>
</head>
<body>
<div class="page">
  <h1>${escapeHtml(meeting.title)}</h1>
  <div class="meta">
    <span>时间：${fmtDateTime(meeting.startedAt)} – ${endText}（${dur}）</span>
    <span>参会人：${people}</span>
    <span>发言条数：${utterances.length}</span>
  </div>

  <h2>议题</h2>
  ${topicHtml}

  <h2>✅ 决议</h2>
  ${decisionHtml}

  <h2>📋 待办事项</h2>
  <table>
    <thead><tr><th style="width:42%">内容</th><th style="width:14%">负责人</th><th style="width:20%">截止</th><th style="width:10%">优先级</th><th style="width:14%">状态</th></tr></thead>
    <tbody>${actionRows}</tbody>
  </table>

  <h2>📝 附录：完整发言记录</h2>
  ${uttHtml}

  <div class="footer">
    MeetingMind 导出于 ${fmtDateTime(Date.now())}　·　本页可用 Ctrl/Cmd + P 直接打印或另存为 PDF
  </div>
</div>
</body>
</html>`;
}
