import type { CloudStatus } from '@/types/models';
import { withTimeout } from '@/lib/utils';

/** CloudBase 全局对象的极简形态（避免引入 sdk 自带类型造成耦合） */
export interface CloudbaseLike {
  init: (opts: { env?: string; region?: string; accessKey?: string; appSign?: string }) => CloudbaseAppLike;
  [key: string]: unknown;
}

/** CloudBase App 的极简形态 */
export interface CloudbaseAppLike {
  auth: (opts?: { persistence?: string }) => {
    signInAnonymously: () => Promise<unknown>;
    getLoginState?: () => Promise<{ isLoggedIn?: boolean; user?: { openid?: string } } | null>;
    hasLoginState?: () => Promise<{ isLoggedIn?: boolean; user?: { openid?: string } } | null>;
  };
  database?: () => CloudbaseDbLike;
  ai?: () => {
    createModel: (name: string) => unknown;
  };
  [key: string]: unknown;
}

/** 文档数据库极简形态 */
export interface CloudbaseDbLike {
  collection: (name: string) => CloudbaseCollectionLike;
}

/** 集合极简形态 */
export interface CloudbaseCollectionLike {
  doc: (id: string) => {
    set: (data: Record<string, unknown>) => Promise<unknown>;
    get: () => Promise<{ data: unknown }>;
    remove: () => Promise<unknown>;
    update: (data: Record<string, unknown>) => Promise<unknown>;
  };
  where: (q: Record<string, unknown>) => CloudbaseQueryLike;
  add: (data: Record<string, unknown>) => Promise<{ id?: string }>;
}

/** 查询极简形态 */
export interface CloudbaseQueryLike {
  limit: (n: number) => CloudbaseQueryLike;
  orderBy: (field: string, order: 'asc' | 'desc') => CloudbaseQueryLike;
  get: () => Promise<{ data: unknown[] }>;
  remove: () => Promise<{ removed?: number }>;
}

/** CDN 兜底地址（npm 包不可用时使用） */
const CDN_URL = 'https://static.cloudbase.net/cloudbase-js-sdk/2.28.8/cloudbase.full.js';
/** 默认探测超时（不阻塞首屏） */
export const DEFAULT_PROBE_TIMEOUT = 3000;

/**
 * CloudBase 客户端。
 * ★ 铁律：init 全程异步、带 3s 超时，**绝不阻塞首屏**；
 *   失败只影响「云端镜像 / AI 整理」，本地功能 100% 可用。
 *
 * 加载顺序：window.cloudbase（CDN 已注入）→ npm 动态 import → CDN 脚本注入。
 */
class CloudBaseClient {
  private sdk: CloudbaseLike | null = null;
  private app: CloudbaseAppLike | null = null;
  private status: CloudStatus = 'probing';
  private reason = '';
  private openid = '';
  private probing: Promise<CloudStatus> | null = null;
  private readonly aiModels = new Map<string, unknown>();

  /** 当前状态 */
  getStatus(): CloudStatus {
    return this.status;
  }

  /** 降级原因（中文，展示在顶部提示条） */
  getReason(): string {
    return this.reason;
  }

  /** 云端是否已就绪 */
  isReady(): boolean {
    return this.status === 'cloud' && this.app !== null;
  }

  /** 匿名登录后的 openid（本地模式为 ''） */
  getOpenId(): string {
    return this.openid;
  }

  /** 取 app 句柄（未就绪返回 null） */
  getApp(): CloudbaseAppLike | null {
    return this.app;
  }

  /** 取文档数据库（未就绪返回 null） */
  getDb(): CloudbaseDbLike | null {
    const db = this.app?.database?.();
    return db ?? null;
  }

  /** 是否配置了云环境（未配置直接判定为本地模式，不去网络） */
  isConfigured(): boolean {
    const flag = (import.meta.env?.VITE_ENABLE_CLOUD ?? '').toString().trim().toLowerCase();
    if (flag === 'false') return false;
    const env = (import.meta.env?.VITE_CLOUDBASE_ENV ?? '').toString().trim();
    return env.length > 0;
  }

  /** 环境 ID */
  private envId(): string {
    return (import.meta.env?.VITE_CLOUDBASE_ENV ?? '').toString().trim();
  }

  /** 地域 */
  private region(): string {
    return (import.meta.env?.VITE_CLOUDBASE_REGION ?? 'ap-shanghai').toString().trim() || 'ap-shanghai';
  }

  /**
   * 探测云端（幂等：并发调用共用一次探测结果）。
   * @param timeoutMs 超时毫秒，默认 3000
   */
  probe(timeoutMs: number = DEFAULT_PROBE_TIMEOUT): Promise<CloudStatus> {
    if (this.status === 'cloud') return Promise.resolve('cloud');
    if (this.probing) return this.probing;
    this.probing = this.doProbe(timeoutMs)
      .then((s) => s)
      .finally(() => {
        this.probing = null;
      });
    return this.probing;
  }

  /** 手动重试（设置弹窗「重试云端连接」） */
  async retry(timeoutMs: number = DEFAULT_PROBE_TIMEOUT): Promise<CloudStatus> {
    this.status = 'probing';
    this.reason = '';
    this.app = null;
    this.openid = '';
    this.aiModels.clear();
    return this.probe(timeoutMs);
  }

  /** 强制切回本地模式（设置弹窗「关闭云端」） */
  forceLocal(reason = '已切换为纯本地模式'): void {
    this.status = 'local';
    this.reason = reason;
    this.app = null;
    this.openid = '';
  }

  /**
   * 获取 AI 模型句柄（CloudAiStructurer 用）。
   * @param name 模型名，默认 'hunyuan-exp'
   */
  async getAiModel(name = 'hunyuan-exp'): Promise<unknown | null> {
    if (!this.isReady()) return null;
    const cached = this.aiModels.get(name);
    if (cached) return cached;
    try {
      const ai = this.app?.ai?.();
      const model = ai ? ai.createModel(name) : null;
      if (model) this.aiModels.set(name, model);
      return model ?? null;
    } catch {
      return null;
    }
  }

  /** 实际探测流程 */
  private async doProbe(timeoutMs: number): Promise<CloudStatus> {
    if (!this.isConfigured()) {
      this.status = 'local';
      this.reason = '未配置云开发环境，已使用本地模式';
      return 'local';
    }
    const sdk = await withTimeout(this.loadSdk(), timeoutMs, null);
    if (!sdk) {
      this.status = 'local';
      this.reason = '云端连接超时，已使用本地模式继续';
      return 'local';
    }
    try {
      const app = sdk.init({ env: this.envId(), region: this.region() });
      const auth = app.auth({ persistence: 'local' });
      const state = await withTimeout(Promise.resolve(auth.hasLoginState?.() ?? null), 1500, null);
      const logged = Boolean(state && typeof state === 'object' && (state as { isLoggedIn?: boolean }).isLoggedIn);
      if (!logged) {
        const r = await withTimeout(auth.signInAnonymously(), Math.max(1000, timeoutMs - 500), null);
        if (r === null) {
          this.status = 'local';
          this.reason = '云端连接超时，已使用本地模式继续';
          return 'local';
        }
      }
      const finalState = await withTimeout(Promise.resolve(auth.hasLoginState?.() ?? null), 1000, null);
      const st = finalState as { user?: { openid?: string } } | null;
      this.openid = st?.user?.openid ?? '';
      this.app = app;
      this.status = 'cloud';
      this.reason = '';
      return 'cloud';
    } catch {
      this.status = 'local';
      this.reason = '云端初始化失败，已使用本地模式继续';
      return 'local';
    }
  }

  /** 加载 SDK：全局 → npm 动态 import → CDN 注入 */
  private async loadSdk(): Promise<CloudbaseLike | null> {
    if (this.sdk) return this.sdk;
    const g = window as unknown as { cloudbase?: CloudbaseLike };
    if (g.cloudbase && typeof g.cloudbase.init === 'function') {
      this.sdk = g.cloudbase;
      return this.sdk;
    }
    try {
      // 注意：这里的 `as string` 只为让 TS 不解析该模块的类型（返回 Promise<any>），
      // 编译后仍是字面量动态 import，Vite/Rollup 可正常分包，绝不阻塞首屏。
      const mod: unknown = await import('@cloudbase/js-sdk' as string);
      const candidate = (mod as { default?: CloudbaseLike }).default ?? (mod as CloudbaseLike);
      if (candidate && typeof candidate.init === 'function') {
        this.sdk = candidate;
        return this.sdk;
      }
    } catch {
      /* 落到 CDN 兜底 */
    }
    try {
      await this.injectScript(CDN_URL);
      if (g.cloudbase && typeof g.cloudbase.init === 'function') {
        this.sdk = g.cloudbase;
        return this.sdk;
      }
    } catch {
      /* 忽略：无云功能不受影响 */
    }
    return null;
  }

  /** 注入 CDN 脚本 */
  private injectScript(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const existed = document.querySelector<HTMLScriptElement>(`script[data-mm-cloud="1"]`);
      if (existed) {
        existed.addEventListener('load', () => resolve());
        existed.addEventListener('error', () => reject(new Error('cdn failed')));
        return;
      }
      const el = document.createElement('script');
      el.src = url;
      el.async = true;
      el.setAttribute('data-mm-cloud', '1');
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('cdn failed'));
      document.head.appendChild(el);
    });
  }
}

/** 单例 */
export const cloudbaseClient = new CloudBaseClient();
export default cloudbaseClient;
