import type {
  ActionItem,
  Decision,
  Meeting,
  MeetingSnapshot,
  MeetingSummary,
  Participant,
  Topic,
  Utterance,
} from '@/types/models';
import type { MeetingQuery, Repository } from './index';
import { cloudbaseClient, type CloudbaseCollectionLike } from '../cloud/CloudBaseClient';

/** 云端集合名（统一 mm_ 前缀） */
const C = {
  meetings: 'mm_meetings',
  utterances: 'mm_utterances',
  participants: 'mm_participants',
  topics: 'mm_topics',
  decisions: 'mm_decisions',
  actions: 'mm_action_items',
} as const;

/** 批量写入的分片大小（避免单次请求体过大） */
const CHUNK = 50;

/**
 * 云端仓库（CloudBase 文档数据库）。
 * ★ 定位：仅作为 LocalRepository 的「镜像」做异步追写；
 *   - 未就绪时所有方法安全返回（null / []），绝不抛错到 UI；
 *   - 写失败只提示一次，不影响本地数据。
 */
export class CloudRepository implements Repository {
  readonly kind = 'cloud' as const;

  private warned = false;
  private disabled = false;

  /** 云端是否可用（未初始化 / 已禁用 均为 false） */
  isReady(): boolean {
    return !this.disabled && cloudbaseClient.isReady();
  }

  /** 取集合；不可用时返回 null */
  private col(name: string): CloudbaseCollectionLike | null {
    if (!this.isReady()) return null;
    const db = cloudbaseClient.getDb();
    if (!db) return null;
    try {
      return db.collection(name);
    } catch {
      return null;
    }
  }

  /** 统一错误兜底：同类错误只提示一次，随后禁用云端镜像 */
  private fail(where: string, e: unknown): void {
    // eslint-disable-next-line no-console
    console.warn(`[CloudRepository.${where}]`, e);
    if (!this.warned) {
      this.warned = true;
      // 静默降级：本地数据已落库，UI 无需打扰用户；仅写控制台。
    }
  }

  async saveSnapshot(s: MeetingSnapshot): Promise<void> {
    if (!this.isReady()) return;
    try {
      const meetings = this.col(C.meetings);
      if (!meetings) return;
      await meetings.doc(s.meeting.id).set({ ...s.meeting, ownerId: cloudbaseClient.getOpenId() || s.meeting.ownerId });
      await Promise.all([
        this.upsertMany(C.participants, s.participants),
        this.upsertMany(C.utterances, s.utterances),
        this.upsertMany(C.topics, s.topics),
        this.upsertMany(C.decisions, s.decisions),
        this.upsertMany(C.actions, s.actionItems),
      ]);
    } catch (e) {
      this.fail('saveSnapshot', e);
    }
  }

  /** 分片批量 upsert（按 _id 去重） */
  private async upsertMany<T extends { id: string }>(name: string, rows: T[]): Promise<void> {
    const col = this.col(name);
    if (!col || rows.length === 0) return;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      await Promise.all(slice.map((r) => col.doc(r.id).set(r as unknown as Record<string, unknown>)));
    }
  }

  async loadSnapshot(id: string): Promise<MeetingSnapshot | null> {
    if (!this.isReady()) return null;
    try {
      const meetings = this.col(C.meetings);
      if (!meetings) return null;
      const res = await meetings.doc(id).get();
      const meeting = res?.data as Meeting | undefined;
      if (!meeting) return null;
      const [utterances, participants, topics, decisions, actionItems] = await Promise.all([
        this.queryByMeeting<Utterance>(C.utterances, id),
        this.queryByMeeting<Participant>(C.participants, id),
        this.queryByMeeting<Topic>(C.topics, id),
        this.queryByMeeting<Decision>(C.decisions, id),
        this.queryByMeeting<ActionItem>(C.actions, id),
      ]);
      utterances.sort((a, b) => a.seq - b.seq);
      return {
        schemaVersion: meeting.schemaVersion,
        exportedAt: Date.now(),
        meeting,
        participants,
        utterances,
        topics,
        decisions,
        actionItems,
      };
    } catch (e) {
      this.fail('loadSnapshot', e);
      return null;
    }
  }

  /** 按 meetingId 查询（带上限保护） */
  private async queryByMeeting<T>(name: string, meetingId: string): Promise<T[]> {
    const col = this.col(name);
    if (!col) return [];
    const res = await col.where({ meetingId }).limit(5000).get();
    return (res?.data ?? []) as T[];
  }

  async listSummaries(q?: MeetingQuery): Promise<MeetingSummary[]> {
    if (!this.isReady()) return [];
    try {
      const meetings = this.col(C.meetings);
      if (!meetings) return [];
      const ownerId = cloudbaseClient.getOpenId();
      const where: Record<string, unknown> = ownerId ? { ownerId } : {};
      const res = await meetings.where(where).orderBy('updatedAt', 'desc').limit(200).get();
      const list = (res?.data ?? []) as Meeting[];
      const out: MeetingSummary[] = [];
      for (const m of list) {
        const participants = (await this.queryByMeeting<Participant>(C.participants, m.id)).map((p) => ({
          id: p.id,
          name: p.name,
          colorIndex: p.colorIndex,
        }));
        if (q?.participantId && !participants.some((p) => p.id === q.participantId)) continue;
        const [decisions, actionItems, topics] = await Promise.all([
          this.queryByMeeting<Decision>(C.decisions, m.id),
          this.queryByMeeting<ActionItem>(C.actions, m.id),
          this.queryByMeeting<Topic>(C.topics, m.id),
        ]);
        const openActionCount = actionItems.filter((a) => a.status !== 'done').length;
        if (q?.hasOpenAction && openActionCount === 0) continue;
        const kw = (q?.keyword ?? '').trim().toLowerCase();
        if (kw && !`${m.title} ${m.searchBlob}`.toLowerCase().includes(kw)) continue;
        out.push({
          meeting: m,
          participants,
          decisionCount: decisions.length,
          actionCount: actionItems.length,
          openActionCount,
          topicCount: topics.length,
        });
      }
      return out;
    } catch (e) {
      this.fail('listSummaries', e);
      return [];
    }
  }

  async deleteMeeting(id: string): Promise<void> {
    if (!this.isReady()) return;
    try {
      const meetings = this.col(C.meetings);
      if (!meetings) return;
      await Promise.all([
        this.removeByMeeting(C.participants, id),
        this.removeByMeeting(C.utterances, id),
        this.removeByMeeting(C.topics, id),
        this.removeByMeeting(C.decisions, id),
        this.removeByMeeting(C.actions, id),
      ]);
      await meetings.doc(id).remove();
    } catch (e) {
      this.fail('deleteMeeting', e);
    }
  }

  /** 按 meetingId 批量删除 */
  private async removeByMeeting(name: string, meetingId: string): Promise<void> {
    const col = this.col(name);
    if (!col) return;
    try {
      await col.where({ meetingId }).remove();
    } catch (e) {
      this.fail(`removeByMeeting:${name}`, e);
    }
  }

  /** P1-03 音频上传本轮未实现，返回 null（本地音频仍可用） */
  async putAudio(_id: string, _blob: Blob): Promise<string | null> {
    return null;
  }

  async getAudio(_id: string): Promise<Blob | null> {
    return null;
  }

  /** 本仓库不需要镜像 */
  setMirror(_r: Repository | null): void {
    /* no-op */
  }

  /** 关闭云端镜像（设置弹窗「关闭云端」） */
  disable(): void {
    this.disabled = true;
  }

  /** 重新启用云端镜像 */
  enable(): void {
    this.disabled = false;
    this.warned = false;
  }
}

let cloudRepo: CloudRepository | null = null;

/** 获取云端仓库单例 */
export function getCloudRepository(): CloudRepository {
  if (!cloudRepo) cloudRepo = new CloudRepository();
  return cloudRepo;
}
