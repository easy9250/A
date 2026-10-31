import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSpeechProvider,
  probeWebSpeech,
  type SpeechEventHandlers,
} from '@/core/speech';
import { WebSpeechProvider } from '@/core/speech/WebSpeechProvider';
import { useMeetingStore } from '@/stores/useMeetingStore';

class FakeSpeechRecognition {
  static instances: FakeSpeechRecognition[] = [];
  static startBehavior: ((instance: FakeSpeechRecognition) => void) | null = null;

  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onresult: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;
  start = vi.fn(() => {
    this.onstart?.();
    FakeSpeechRecognition.startBehavior?.(this);
  });
  stop = vi.fn();
  abort = vi.fn();

  constructor() {
    FakeSpeechRecognition.instances.push(this);
  }

  addEventListener(): void {
    // 当前实现使用 onresult/onerror/onend 属性；保留方法满足构造器契约。
  }
}

function resultEvent(
  entries: Array<{ text: string; final: boolean; confidence?: number }>,
  resultIndex = 0,
): any {
  const results = entries.map(({ text, final, confidence = 0.9 }) => {
    const alternative = { transcript: text, confidence };
    return {
      0: alternative,
      length: 1,
      isFinal: final,
      item: () => alternative,
    };
  });
  return {
    resultIndex,
    results: Object.assign(results, { item: (index: number) => results[index] }),
  };
}

function installCtor(): void {
  Object.defineProperty(window, 'SpeechRecognition', {
    configurable: true,
    writable: true,
    value: FakeSpeechRecognition,
  });
}

function setSecureContext(value: boolean): void {
  Object.defineProperty(window, 'isSecureContext', {
    configurable: true,
    value,
  });
}

function makeHandlers(): SpeechEventHandlers & Record<string, ReturnType<typeof vi.fn>> {
  return {
    onInterim: vi.fn(),
    onFinal: vi.fn(),
    onNotice: vi.fn(),
    onLevelChange: vi.fn(),
    onAutoRestart: vi.fn(),
  };
}

beforeEach(() => {
  FakeSpeechRecognition.instances = [];
  FakeSpeechRecognition.startBehavior = null;
  setSecureContext(true);
  Object.defineProperty(window, 'SpeechRecognition', { configurable: true, writable: true, value: undefined });
  Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, writable: true, value: undefined });
  useMeetingStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
  useMeetingStore.getState().reset();
});

describe('probeWebSpeech 与三档工厂降级', () => {
  it('探活拿到非空结果时成功，并配置 continuous/interim/zh-CN', async () => {
    installCtor();
    FakeSpeechRecognition.startBehavior = (instance) => {
      instance.onresult?.(resultEvent([{ text: '探活成功', final: false }]));
    };

    await expect(probeWebSpeech(50)).resolves.toBe(true);
    const rec = FakeSpeechRecognition.instances[0];
    expect(rec.lang).toBe('zh-CN');
    expect(rec.continuous).toBe(true);
    expect(rec.interimResults).toBe(true);
    expect(rec.maxAlternatives).toBe(1);
  });

  it.each(['network', 'service-not-allowed', 'not-allowed', 'audio-capture'])('%s 错误令探活失败', async (error) => {
    installCtor();
    FakeSpeechRecognition.startBehavior = (instance) => {
      instance.onerror?.({ error });
    };

    await expect(probeWebSpeech(50)).resolves.toBe(false);
  });

  it('no-speech 与 aborted 只作为噪声，直到探活超时才失败', async () => {
    vi.useFakeTimers();
    installCtor();
    FakeSpeechRecognition.startBehavior = (instance) => {
      instance.onerror?.({ error: 'no-speech' });
      instance.onerror?.({ error: 'aborted' });
    };

    const result = probeWebSpeech(80);
    await vi.advanceTimersByTimeAsync(79);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(false);
  });

  it('无 SpeechRecognition 构造器时选择 L1 并明示等级变化', async () => {
    const handlers = makeHandlers();

    const provider = await createSpeechProvider(handlers, { lang: 'zh-CN', probeMs: 10, micOk: true });

    expect(provider.level).toBe(1);
    expect(provider.mode).toBe('record-only');
    expect(handlers.onLevelChange).toHaveBeenCalledWith(1, expect.stringContaining('录音模式'));
  });

  it('非安全上下文或麦克风不可用时选择 L2', async () => {
    const insecureHandlers = makeHandlers();
    setSecureContext(false);
    const insecure = await createSpeechProvider(insecureHandlers, { lang: 'zh-CN', micOk: true });
    expect(insecure.level).toBe(2);
    expect(insecureHandlers.onLevelChange).toHaveBeenCalledWith(2, expect.stringContaining('HTTPS'));

    setSecureContext(true);
    const micHandlers = makeHandlers();
    const noMic = await createSpeechProvider(micHandlers, { lang: 'zh-CN', micOk: false });
    expect(noMic.level).toBe(2);
    expect(micHandlers.onLevelChange).toHaveBeenCalledWith(2, expect.stringContaining('麦克风不可用'));
  });

  it('探活成功后工厂选择 L0', async () => {
    installCtor();
    FakeSpeechRecognition.startBehavior = (instance) => {
      instance.onresult?.(resultEvent([{ text: '服务可用', final: false }]));
    };
    const handlers = makeHandlers();

    const provider = await createSpeechProvider(handlers, { lang: 'zh-CN', probeMs: 20 });

    expect(provider).toBeInstanceOf(WebSpeechProvider);
    expect(provider.level).toBe(0);
    expect(handlers.onLevelChange).toHaveBeenCalledWith(0, '');
  });
});

describe('WebSpeechProvider 结果、重启与降级', () => {
  it('同一 resultIndex 的 final 重复投递时不重不漏', async () => {
    installCtor();
    const handlers = makeHandlers();
    const provider = new WebSpeechProvider(handlers, 'zh-CN');
    await provider.start(null);
    const rec = FakeSpeechRecognition.instances[0];
    const event = resultEvent([
      { text: '第一条最终结果', final: true, confidence: 0.8 },
      { text: '第二条最终结果', final: true, confidence: 0.7 },
    ]);

    rec.onresult?.(event);
    rec.onresult?.(event);

    expect(handlers.onFinal).toHaveBeenCalledTimes(2);
    expect(handlers.onFinal).toHaveBeenNthCalledWith(1, '第一条最终结果', expect.any(Number), 0.8, 'asr');
    expect(handlers.onFinal).toHaveBeenNthCalledWith(2, '第二条最终结果', expect.any(Number), 0.7, 'asr');
    provider.destroy();
  });

  it('interim 只调用 onInterim，绝不写入会议 uttMap', async () => {
    installCtor();
    useMeetingStore.getState().startMeeting('interim 性能契约');
    const handlers = makeHandlers();
    const provider = new WebSpeechProvider(handlers, 'zh-CN');
    await provider.start(null);
    const rec = FakeSpeechRecognition.instances[0];

    rec.onresult?.(resultEvent([{ text: '仍在识别中的文字', final: false }]));

    expect(handlers.onInterim).toHaveBeenCalledTimes(1);
    expect(handlers.onFinal).not.toHaveBeenCalled();
    expect(useMeetingStore.getState().utteranceIds).toHaveLength(0);
    expect(useMeetingStore.getState().uttMap).toEqual({});
    provider.destroy();
  });

  it('onend 后 300ms 自动重启并报告重连次数', async () => {
    vi.useFakeTimers();
    installCtor();
    const handlers = makeHandlers();
    const provider = new WebSpeechProvider(handlers, 'zh-CN');
    await provider.start(null);
    expect(FakeSpeechRecognition.instances).toHaveLength(1);

    FakeSpeechRecognition.instances[0].onend?.();
    await vi.advanceTimersByTimeAsync(299);
    expect(FakeSpeechRecognition.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(FakeSpeechRecognition.instances).toHaveLength(2);
    expect(handlers.onAutoRestart).toHaveBeenCalledWith(1);
    provider.destroy();
  });

  it('连续三次致命错误触发 L1 降级', async () => {
    installCtor();
    const handlers = makeHandlers();
    const provider = new WebSpeechProvider(handlers, 'zh-CN');
    await provider.start(null);
    const rec = FakeSpeechRecognition.instances[0];
    const onerror = rec.onerror!;

    onerror({ error: 'network' });
    onerror({ error: 'network' });
    expect(handlers.onLevelChange).not.toHaveBeenCalled();
    onerror({ error: 'network' });

    expect(handlers.onLevelChange).toHaveBeenCalledTimes(1);
    expect(handlers.onLevelChange).toHaveBeenCalledWith(1, expect.stringContaining('录音模式'));
  });

  it('no-speech 与 aborted 不增加失败次数，也不触发降级', async () => {
    installCtor();
    const handlers = makeHandlers();
    const provider = new WebSpeechProvider(handlers, 'zh-CN');
    await provider.start(null);
    const rec = FakeSpeechRecognition.instances[0];

    rec.onerror?.({ error: 'no-speech' });
    rec.onerror?.({ error: 'aborted' });
    rec.onerror?.({ error: 'no-speech' });
    rec.onerror?.({ error: 'aborted' });

    expect(handlers.onLevelChange).not.toHaveBeenCalled();
    provider.destroy();
  });
});
