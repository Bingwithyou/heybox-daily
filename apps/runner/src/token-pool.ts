import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

interface Child {
  process: ChildProcess;
  used: boolean;
  ready: boolean;
  result: Promise<string>;
  closed: Promise<void>;
  start(): void;
  fail(): void;
}
interface Options {
  childPath?: string;
  prewarm?: boolean;
  maxChildren?: number;
  startupMs?: number;
  requestMs?: number;
  retryMs?: number;
}

export class TokenPool {
  private readonly children = new Set<Child>();
  private spare?: Child;
  private stopping = false;
  private refill?: ReturnType<typeof setTimeout>;
  private readonly options: Required<Options>;
  constructor(options: Options = {}) {
    this.options = { childPath: fileURLToPath(new URL('./token-child.ts', import.meta.url)), prewarm: true,
      maxChildren: 4, startupMs: 10_000, requestMs: 30_000, retryMs: 1000, ...options };
    this.ensureSpare();
  }
  snapshot() {
    return { children: this.children.size, idle: this.spare ? 1 : 0, ready: this.spare?.ready ? 1 : 0,
      active: [...this.children].filter(child => child.used).length };
  }
  private ensureSpare() {
    if (!this.stopping && this.options.prewarm && !this.spare && this.children.size < this.options.maxChildren)
      this.spare = this.spawn();
  }
  private spawn(): Child {
    const processChild = spawn(process.execPath, [this.options.childPath], {
      stdio: ['ignore', 'pipe', 'ignore', 'ipc'], detached: process.platform !== 'win32',
      env: { PATH: process.env.PATH, NODE_ENV: 'production', TZ: 'Asia/Shanghai' },
    });
    let value: string | undefined;
    let failed = false;
    let sent = false;
    let outputBytes = 0;
    let resolve!: (value: string) => void;
    let reject!: (error: Error) => void;
    let closed!: () => void;
    const result = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    // An idle process has no caller; its failure schedules replacement below.
    void result.catch(() => {});
    const child: Child = {
      process: processChild, used: false, ready: false, result, closed: new Promise<void>(r => closed = r),
      start: () => {
        if (sent || failed || !child.ready || !child.used) return;
        sent = true;
        processChild.send({ type: 'generate' }, error => { if (error) child.fail(); });
      },
      fail: () => {
        if (failed) return;
        failed = true;
        try {
          if (processChild.pid && process.platform !== 'win32') process.kill(-processChild.pid, 'SIGKILL');
          else processChild.kill('SIGKILL');
        } catch { /* close releases the slot for an already exited process */ }
      },
    };
    this.children.add(child);
    const startup = setTimeout(child.fail, this.options.startupMs);
    processChild.on('error', child.fail);
    processChild.stdout!.on('data', (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > 1024) child.fail(); });
    processChild.on('message', message => {
      if (!message || typeof message !== 'object' || !('type' in message)) { child.fail(); return; }
      if (message.type === 'ready' && !child.ready) {
        child.ready = true; clearTimeout(startup); child.start();
      } else if (message.type === 'token' && sent && !value && 'token' in message
          && typeof message.token === 'string' && /^B[A-Za-z0-9+/=_-]{88}$/.test(message.token)) value = message.token;
      else child.fail();
    });
    processChild.once('close', code => {
      clearTimeout(startup);
      this.children.delete(child);
      if (this.spare === child) this.spare = undefined;
      const succeeded = !failed && code === 0 && value;
      if (succeeded) resolve(succeeded); else reject(new Error('设备令牌生成失败'));
      closed();
      // Replenish after exit to avoid extra startup CPU on the request's critical path.
      if (!this.stopping && !this.refill) this.refill = setTimeout(() => {
        this.refill = undefined; this.ensureSpare();
      }, succeeded ? 0 : this.options.retryMs);
    });
    return child;
  }
  async generate(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (this.stopping) throw new Error('设备令牌服务正在停止');
    if (!this.spare && this.children.size >= this.options.maxChildren) throw new Error('设备令牌服务繁忙');
    const child = this.spare || this.spawn();
    if (this.spare === child) this.spare = undefined;
    child.used = true;
    const abort = () => child.fail();
    const timer = setTimeout(abort, this.options.requestMs);
    signal.addEventListener('abort', abort, { once: true });
    child.start();
    try { return await child.result; }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  async stop() {
    this.stopping = true; clearTimeout(this.refill); this.refill = undefined;
    const children = [...this.children];
    children.forEach(child => child.fail());
    await Promise.all(children.map(child => child.closed));
  }
}
