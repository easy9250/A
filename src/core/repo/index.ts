import type { MeetingSnapshot, MeetingSummary } from '@/types/models';
import { LocalRepository } from './LocalRepository';
import { CloudRepository, getCloudRepository } from './CloudRepository';

/** 仓库种类 */
export type RepoKind = 'local' | 'cloud';

/** 历史列表查询条件 */
export interface MeetingQuery {
  keyword?: string;
  participantId?: string;
  hasOpenAction?: boolean;
}

/** 统一错误码（与 §7.7 中文文案表一一对应） */
export type MMErrCode =
  | 'MIC_DENIED'
  | 'MIC_NOT_FOUND'
  | 'INSECURE_CONTEXT'
  | 'ASR_UNAVAILABLE'
  | 'ASR_NETWORK'
  | 'ASR_RESTARTED'
  | 'CLOUD_TIMEOUT'
  | 'CLOUD_INIT_FAIL'
  | 'AI_TIMEOUT'
  | 'AI_FAIL'
  | 'STORAGE_QUOTA'
  | 'EXPORT_FAIL'
  | 'DELETE_CONFIRM'
  | 'IDB_FAIL'
  | 'UNKNOWN';

/** 项目统一错误类型：携带机器可读 code，便于映射中文文案 */
export class MMError extends Error {
  public readonly code: MMErrCode;

  constructor(code: MMErrCode, msg: string) {
    super(msg);
    this.name = 'MMError';
    this.code = code;
  }
}

/** 错误码 → 中文文案（结尾不加句号） */
const ERR_TEXT: Record<MMErrCode, string> = {
  MIC_DENIED: '麦克风权限被拒绝，请在浏览器地址栏站点设置中允许后重试',
  MIC_NOT_FOUND: '未检测到可用的音频输入设备',
  INSECURE_CONTEXT: '当前不是 HTTPS 或 localhost，浏览器禁止访问麦克风，请使用本地运行或部署到 HTTPS',
  ASR_UNAVAILABLE: '浏览器不支持实时语音识别，已切换为「录音模式」，会后转为文字',
  ASR_NETWORK: '识别服务暂时不可用，已切换为「录音模式」',
  ASR_RESTARTED: '识别连接已自动恢复，文本未丢失',
  CLOUD_TIMEOUT: '云端连接超时，已使用本地模式继续',
  CLOUD_INIT_FAIL: '云端初始化失败，已使用本地模式继续',
  AI_TIMEOUT: 'AI 整理超时，已使用本地规则生成初稿',
  AI_FAIL: 'AI 整理失败，已使用本地规则生成初稿',
  STORAGE_QUOTA: '本地存储空间不足，请先导出备份并清理历史会议',
  EXPORT_FAIL: '导出失败，请重试或改用其他格式',
  DELETE_CONFIRM: '删除后不可恢复，确定删除这场会议吗',
  IDB_FAIL: '本地数据库读写失败，数据可能未保存，请及时导出备份',
  UNKNOWN: '发生未知错误，请重试',
};

/** 把任意异常统一转成中文文案（永不把英文栈抛给 UI） */
export function errText(e: unknown): string {
  if (e instanceof MMError) return ERR_TEXT[e.code] ?? e.message;
  if (e instanceof Error && e.message) return e.message;
  return ERR_TEXT.UNKNOWN;
}

/** 取错误码（非 MMError 返回 UNKNOWN） */
export function errCode(e: unknown): MMErrCode {
  if (e instanceof MMError) return e.code;
  return 'UNKNOWN';
}

/**
 * 数据访问统一接口。
 * - LocalRepository：IndexedDB，永远可用，是唯一的主实现；
 * - CloudRepository：CloudBase 文档数据库，仅作为「镜像」异步追写。
 */
export interface Repository {
  readonly kind: RepoKind;
  /** 写入快照。Local 侧内部只增量写 utterances */
  saveSnapshot(s: MeetingSnapshot): Promise<void>;
  /** 读取整场会议；不存在返回 null */
  loadSnapshot(id: string): Promise<MeetingSnapshot | null>;
  /** 历史列表（含派生计数与命中片段） */
  listSummaries(q?: MeetingQuery): Promise<MeetingSummary[]>;
  /** 删除整场会议及其子数据 */
  deleteMeeting(id: string): Promise<void>;
  /** 存音频，返回 audioLocalKey / audioUrl */
  putAudio(id: string, blob: Blob): Promise<string | null>;
  /** 读音频 */
  getAudio(id: string): Promise<Blob | null>;
  /** 装饰器式镜像：云就绪后挂上 CloudRepository，此后本地写会异步追写云端 */
  setMirror(r: Repository | null): void;
}

let localRepo: LocalRepository | null = null;

/**
 * 获取本地仓库单例。
 * ★ 铁律：无论云端是否可用，getRepo() 永远返回 LocalRepository，
 *   云端只通过 setMirror() 以镜像方式异步追写，绝不阻塞主链路。
 */
export function getRepo(): LocalRepository {
  if (!localRepo) localRepo = new LocalRepository();
  return localRepo;
}

/** 测试/清空场景用：销毁单例 */
export function resetRepo(): void {
  if (localRepo) localRepo.setMirror(null);
  localRepo = null;
}

/**
 * 云端就绪后调用：把 CloudRepository 挂到本仓库做镜像追写。
 * 内部已做守卫：云不可用时静默跳过，不影响本地。
 */
export function attachCloudMirror(): void {
  const cloud = getCloudRepository();
  if (cloud.isReady()) getRepo().setMirror(cloud);
}

/** 清空全部本地数据（设置弹窗「清空数据」用） */
export async function clearAllLocalData(): Promise<void> {
  await getRepo().clearAll();
}

export { LocalRepository, CloudRepository, getCloudRepository };
