import { openDB, deleteDB, type DBSchema, type IDBPDatabase } from 'idb';
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
import { SEARCH_BLOB_LIMIT } from '@/types/models';
import type { MeetingQuery, Repository } from './index';
import { toast } from '@/stores/useUiStore';
import { highlightSnippet, sanitizeScan } from '@/lib/utils';

/** 数据库名与版本（v1 冻结，勿随意升级） */
const DB_NAME = 'meetingmind';
const DB_VERSION = 1;

/** audio store 记录 */
interface AudioRecord {
  meetingId: string;
  blob: Blob;
  mime: string;
  size: number;
  createdAt: number;
}

/** meta store 记录 */
interface MetaRecord<T = unknown> {
  key: string;
  value: T;
}

/** 带 meetingId 的子表 value 类型 */
type ChildEntity = Participant | Topic | Decision | ActionItem;

/** IndexedDB Schema（v1） */
interface MMDB extends DBSchema {
  meetings: {
    key: string;
    value: Meeting;
    indexes: { 'by-updatedAt': number; 'by-status': string };
  };
  utterances: {
    key: string;
    value: Utterance;
    indexes: { 'by-ms': [string, number] };
  };
  participants: { key: string; value: Participant; indexes: { 'by-meeting': string } };
  topics: { key: string; value: Topic; indexes: { 'by-meeting': string } };
  decisions: { key: string; value: Decision; indexes: { 'by-meeting': string } };
  action_items: { key: string; value: ActionItem; indexes: { 'by-meeting': string } };
  audio: { key: string; value: AudioRecord };
  meta: { key: string; value: MetaRecord };
}

const STORE_NAMES = [
  'meetings',
  'utterances',
  'participants',
  'topics',
  'decisions',
  'action_items',
  'audio',
  'meta',
] as const;

type StoreName = (typeof STORE_NAMES)[number];

/** 子表（按 by-meeting 索引清理） */
const CHILD_STORES = ['participants', 'topics', 'decisions', 'action_items'] as const;
type ChildStoreName = (typeof CHILD_STORES)[number];

/** 拼接检索字段：参会人名 + 全部发言正文，截断到 SEARCH_BLOB_LIMIT */
export function buildSearchBlob(participants: Participant[], utterances: Utterance[]): string {
  const names = participants.map((p) => p.name).join(' ');
  const texts = utterances.map((u) => u.text).join(' ');
  const merged = sanitizeScan(`${names} ${texts}`);
  return merged.length > SEARCH_BLOB_LIMIT ? merged.slice(0, SEARCH_BLOB_LIMIT) : merged;
}

/**
 * 本地仓库：IndexedDB 实现。
 * 关键能力：
 * 1) 建库 / 升级，建立全部 store 与索引；
 * 2) saveSnapshot 按 seq 水位 + 内容 diff 做增量写 utterances；
 * 3) 维护 meeting.searchBlob 供历史检索；
 * 4) mirror（云端镜像）异步追写，失败不影响本地。
 *
 * ★ 事务安全约定：所有「读」在建立写事务之前完成，写事务内只做 put/delete，
 *   避免 await 非 IDB Promise 导致事务自动关闭。
 */
export class LocalRepository implements Repository {
  readonly kind = 'local' as const;

  private dbPromise: Promise<IDBPDatabase<MMDB>> | null = null;
  private mirror: Repository | null = null;
  private writeCount = 0;
  private quotaWarned = false;
  private cloudWarned = false;

  /** 打开（或建立）数据库 */
  openDB(): Promise<IDBPDatabase<MMDB>> {
    if (!this.dbPromise) {
      this.dbPromise = openDB<MMDB>(DB_NAME, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains('meetings')) {
            const s = db.createObjectStore('meetings', { keyPath: 'id' });
            s.createIndex('by-updatedAt', 'updatedAt');
            s.createIndex('by-status', 'status');
          }
          if (!db.objectStoreNames.contains('utterances')) {
            const s = db.createObjectStore('utterances', { keyPath: 'id' });
            s.createIndex('by-ms', ['meetingId', 'seq']);
          }
          if (!db.objectStoreNames.contains('participants')) {
            const s = db.createObjectStore('participants', { keyPath: 'id' });
            s.createIndex('by-meeting', 'meetingId');
          }
          if (!db.objectStoreNames.contains('topics')) {
            const s = db.createObjectStore('topics', { keyPath: 'id' });
            s.createIndex('by-meeting', 'meetingId');
          }
          if (!db.objectStoreNames.contains('decisions')) {
            const s = db.createObjectStore('decisions', { keyPath: 'id' });
            s.createIndex('by-meeting', 'meetingId');
          }
          if (!db.objectStoreNames.contains('action_items')) {
            const s = db.createObjectStore('action_items', { keyPath: 'id' });
            s.createIndex('by-meeting', 'meetingId');
          }
          if (!db.objectStoreNames.contains('audio')) {
            db.createObjectStore('audio', { keyPath: 'meetingId' });
          }
          if (!db.objectStoreNames.contains('meta')) {
            db.createObjectStore('meta', { keyPath: 'key' });
          }
        },
        blocked() {
          toast.warning('浏览器正忙，本地数据库暂不可用，请先关闭其他 MeetingMind 标签页');
        },
      });
    }
    return this.dbPromise;
  }

  /** 挂云端镜像（云就绪后调用；传 null 取消） */
  setMirror(r: Repository | null): void {
    this.mirror = r;
  }

  /** 当前镜像（供调试 / UI 展示） */
  getMirror(): Repository | null {
    return this.mirror;
  }

  /** 读 meta */
  private async getMeta<T>(key: string): Promise<T | undefined> {
    const db = await this.openDB();
    const rec = await db.get('meta', key);
    return rec?.value as T | undefined;
  }

  /** 取某场会议的 seq 水位（已写入的最大 seq） */
  private async getWatermark(meetingId: string): Promise<number> {
    const wm = await this.getMeta<number>(`wm:${meetingId}`);
    return typeof wm === 'number' ? wm : 0;
  }

  /** 读取某场会议在库内的全部 utterance（按 seq 升序） */
  private async readUtterances(meetingId: string, db: IDBPDatabase<MMDB>): Promise<Utterance[]> {
    const range = IDBKeyRange.bound([meetingId, 0], [meetingId, Number.MAX_SAFE_INTEGER]);
    return db.getAllFromIndex('utterances', 'by-ms', range);
  }

  /** 读子表现有主键（用于全量覆盖前清理） */
  private async readChildIds(db: IDBPDatabase<MMDB>, store: ChildStoreName, meetingId: string): Promise<string[]> {
    const rows = await db.getAllFromIndex(store, 'by-meeting', meetingId);
    return rows.map((r) => r.id);
  }

  /** 内容比较：只比较会被用户编辑的字段，用于增量判定 */
  private sameUtterance(a: Utterance, b: Utterance): boolean {
    return (
      a.seq === b.seq &&
      a.text === b.text &&
      a.speakerId === b.speakerId &&
      a.startMs === b.startMs &&
      a.endMs === b.endMs &&
      a.source === b.source &&
      a.isFinal === b.isFinal &&
      a.starred === b.starred &&
      (a.marker ?? null) === (b.marker ?? null)
    );
  }

  /**
   * 写快照：
   * - utterances 采用「seq 水位 + 内容 diff」增量写；
   * - 其余实体量小，全量覆盖；
   * - 同步维护 searchBlob；
   * - 成功后 fire-and-forget 追写镜像。
   */
  async saveSnapshot(s: MeetingSnapshot): Promise<void> {
    try {
      const db = await this.openDB();
      const mid = s.meeting.id;

      /* ---------- 阶段一：读（独立事务，避免写事务被 await 关闭） ---------- */
      const watermark = await this.getWatermark(mid);
      const existing = await this.readUtterances(mid, db);
      const existingMap = new Map<string, Utterance>();
      for (const u of existing) existingMap.set(u.id, u);

      const oldChildIds: Record<ChildStoreName, string[]> = {
        participants: await this.readChildIds(db, 'participants', mid),
        topics: await this.readChildIds(db, 'topics', mid),
        decisions: await this.readChildIds(db, 'decisions', mid),
        action_items: await this.readChildIds(db, 'action_items', mid),
      };

      /* ---------- 阶段二：计算差量 ---------- */
      const snapshotIds = new Set<string>();
      const toPut: Utterance[] = [];
      let maxSeq = watermark;
      for (const u of s.utterances) {
        snapshotIds.add(u.id);
        if (u.seq > maxSeq) maxSeq = u.seq;
        const old = existingMap.get(u.id);
        if (!old || u.seq > watermark || !this.sameUtterance(old, u)) toPut.push(u);
      }
      const toDelete: string[] = [];
      for (const id of existingMap.keys()) {
        if (!snapshotIds.has(id)) toDelete.push(id);
      }

      const meeting: Meeting = {
        ...s.meeting,
        searchBlob: buildSearchBlob(s.participants, s.utterances),
        utteranceCount: s.utterances.length,
        updatedAt: Date.now(),
      };

      const nextChildren: Record<ChildStoreName, ChildEntity[]> = {
        participants: s.participants,
        topics: s.topics,
        decisions: s.decisions,
        action_items: s.actionItems,
      };

      /* ---------- 阶段三：写（只做 put/delete） ---------- */
      const tx = db.transaction(STORE_NAMES as unknown as StoreName[], 'readwrite');
      tx.objectStore('meetings').put(meeting);
      const uttStore = tx.objectStore('utterances');
      for (const u of toPut) uttStore.put(u);
      for (const id of toDelete) uttStore.delete(id);

      for (const name of CHILD_STORES) {
        const store = tx.objectStore(name);
        const nextIds = new Set(nextChildren[name].map((n) => n.id));
        for (const id of oldChildIds[name]) if (!nextIds.has(id)) store.delete(id);
        for (const n of nextChildren[name]) store.put(n as never);
      }
      tx.objectStore('meta').put({ key: `wm:${mid}`, value: maxSeq } as MetaRecord);
      await tx.done;

      this.checkQuota();
      this.mirrorWrite(s);
    } catch (e) {
      toast.error('本地保存失败，请及时导出备份');
      // eslint-disable-next-line no-console
      console.error('[LocalRepository.saveSnapshot]', e);
    }
  }

  /** 加载整场会议 */
  async loadSnapshot(id: string): Promise<MeetingSnapshot | null> {
    try {
      const db = await this.openDB();
      const meeting = await db.get('meetings', id);
      if (!meeting) return null;
      const [utterances, participants, topics, decisions, actionItems] = await Promise.all([
        this.readUtterances(id, db),
        db.getAllFromIndex('participants', 'by-meeting', id),
        db.getAllFromIndex('topics', 'by-meeting', id),
        db.getAllFromIndex('decisions', 'by-meeting', id),
        db.getAllFromIndex('action_items', 'by-meeting', id),
      ]);
      utterances.sort((a, b) => a.seq - b.seq);
      topics.sort((a, b) => a.order - b.order);
      decisions.sort((a, b) => a.order - b.order);
      actionItems.sort((a, b) => a.createdAt - b.createdAt);
      participants.sort((a, b) => a.order - b.order);
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
      toast.error('读取本地会议失败');
      // eslint-disable-next-line no-console
      console.error('[LocalRepository.loadSnapshot]', e);
      return null;
    }
  }

  /** 历史列表：内存扫描 searchBlob（500ms 内可达标，避免全表 utterance 扫描） */
  async listSummaries(q?: MeetingQuery): Promise<MeetingSummary[]> {
    try {
      const db = await this.openDB();
      const meetings = await db.getAll('meetings');
      meetings.sort((a, b) => b.updatedAt - a.updatedAt);
      const keyword = sanitizeScan(q?.keyword ?? '').toLowerCase();
      const out: MeetingSummary[] = [];
      for (const m of meetings) {
        const participants = (await db.getAllFromIndex('participants', 'by-meeting', m.id)).map((p) => ({
          id: p.id,
          name: p.name,
          colorIndex: p.colorIndex,
        }));
        if (q?.participantId && !participants.some((p) => p.id === q.participantId)) continue;
        const decisions = await db.getAllFromIndex('decisions', 'by-meeting', m.id);
        const actionItems = await db.getAllFromIndex('action_items', 'by-meeting', m.id);
        const topics = await db.getAllFromIndex('topics', 'by-meeting', m.id);
        const openActionCount = actionItems.filter((a) => a.status !== 'done').length;
        if (q?.hasOpenAction && openActionCount === 0) continue;

        let hitSnippet: string | undefined;
        if (keyword) {
          const inTitle = m.title.toLowerCase().includes(keyword);
          const inBlob = m.searchBlob.toLowerCase().includes(keyword);
          const inParticipant = participants.some((p) => p.name.toLowerCase().includes(keyword));
          if (!inTitle && !inBlob && !inParticipant) continue;
          hitSnippet = highlightSnippet(inTitle ? m.title : m.searchBlob, keyword, 40);
        }
        out.push({
          meeting: m,
          participants,
          decisionCount: decisions.length,
          actionCount: actionItems.length,
          openActionCount,
          topicCount: topics.length,
          hitSnippet,
        });
      }
      return out;
    } catch (e) {
      toast.error('读取历史会议失败');
      // eslint-disable-next-line no-console
      console.error('[LocalRepository.listSummaries]', e);
      return [];
    }
  }

  /** 删除整场会议（含全部子表与音频，同一 readwrite 事务） */
  async deleteMeeting(id: string): Promise<void> {
    try {
      const db = await this.openDB();
      /* 先读后写：避免写事务因 await 而自动关闭 */
      const utts = await this.readUtterances(id, db);
      const oldChildIds: Record<ChildStoreName, string[]> = {
        participants: await this.readChildIds(db, 'participants', id),
        topics: await this.readChildIds(db, 'topics', id),
        decisions: await this.readChildIds(db, 'decisions', id),
        action_items: await this.readChildIds(db, 'action_items', id),
      };

      const tx = db.transaction(STORE_NAMES as unknown as StoreName[], 'readwrite');
      const uttStore = tx.objectStore('utterances');
      for (const u of utts) uttStore.delete(u.id);
      for (const name of CHILD_STORES) {
        const store = tx.objectStore(name);
        for (const cid of oldChildIds[name]) store.delete(cid);
      }
      tx.objectStore('audio').delete(id);
      tx.objectStore('meta').delete(`wm:${id}`);
      tx.objectStore('meetings').delete(id);
      await tx.done;

      if (this.mirror) void this.mirror.deleteMeeting(id).catch(() => undefined);
    } catch (e) {
      toast.error('删除失败，请重试');
      // eslint-disable-next-line no-console
      console.error('[LocalRepository.deleteMeeting]', e);
    }
  }

  /** 存音频 */
  async putAudio(id: string, blob: Blob): Promise<string | null> {
    try {
      const db = await this.openDB();
      const rec: AudioRecord = {
        meetingId: id,
        blob,
        mime: blob.type || 'audio/webm',
        size: blob.size,
        createdAt: Date.now(),
      };
      await db.put('audio', rec);
      const key = `audio:${id}`;
      await db.put('meta', { key, value: { meetingId: id, size: blob.size, createdAt: rec.createdAt } } as MetaRecord);
      return key;
    } catch (e) {
      toast.error('录音保存失败，本次会议的音频未能留存');
      // eslint-disable-next-line no-console
      console.error('[LocalRepository.putAudio]', e);
      return null;
    }
  }

  /** 读音频 */
  async getAudio(id: string): Promise<Blob | null> {
    try {
      const db = await this.openDB();
      const rec = await db.get('audio', id);
      return rec?.blob ?? null;
    } catch {
      return null;
    }
  }

  /** 清空全部本地数据（设置弹窗「清空数据」） */
  async clearAll(): Promise<void> {
    try {
      const db = await this.openDB();
      const tx = db.transaction(STORE_NAMES as unknown as StoreName[], 'readwrite');
      for (const n of STORE_NAMES) tx.objectStore(n).clear();
      await tx.done;
    } catch (e) {
      toast.error('清空数据失败，请刷新页面后重试');
      // eslint-disable-next-line no-console
      console.error('[LocalRepository.clearAll]', e);
    }
  }

  /** 彻底删除数据库（谨慎使用） */
  async dropDatabase(): Promise<void> {
    this.dbPromise = null;
    try {
      await deleteDB(DB_NAME);
    } catch {
      /* 忽略：删库失败不影响主流程 */
    }
  }

  /** 镜像异步追写：失败不影响本地，且同类错误只提示一次 */
  private mirrorWrite(s: MeetingSnapshot): void {
    if (!this.mirror) return;
    void this.mirror
      .saveSnapshot(s)
      .then(() => undefined)
      .catch(() => {
        if (!this.cloudWarned) {
          this.cloudWarned = true;
          toast.warning('云端同步失败，数据已安全保存在本地');
        }
      });
  }

  /** 每 10 次写入检查一次存储配额 */
  private checkQuota(): void {
    this.writeCount += 1;
    if (this.writeCount % 10 !== 0) return;
    if (!navigator.storage?.estimate) return;
    void navigator.storage
      .estimate()
      .then((est) => {
        if (est.usage && est.quota && est.usage / est.quota > 0.8 && !this.quotaWarned) {
          this.quotaWarned = true;
          toast.warning('本地存储空间不足，请先导出备份并清理历史会议');
        }
      })
      .catch(() => undefined);
  }
}
