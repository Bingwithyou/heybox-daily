import { HeyboxApiError, HeyboxClient } from 'heybox-daily/client';
import { inspect, runDaily } from 'heybox-daily/tasks';
import type { Inspection, TaskSnapshot as InspectionSnapshot } from 'heybox-daily/types';
import { beijingDate, jobSchema, taskIds, type Job, type Outcome, type TaskSnapshot } from '@heybox/contracts';
import { decryptCredential } from './crypto.ts';
import { fileURLToPath } from 'node:url';
import { loginStep, type LoginInput } from './login.ts';

export function failureCategory(error: unknown) {
  if (error instanceof HeyboxApiError && error.captchaRequired) return 'captcha_required';
  const text = error instanceof Error ? error.message : '';
  if (/原生签名|签名资源/.test(text)) return 'native_signer';
  if (/设备令牌|官网/.test(text)) return 'device_token';
  if (/频繁|次数.*限制/.test(text)) return 'upstream_rate_limit';
  if (/验证码/.test(text)) return 'verification_code';
  if (/^HTTP \d{3}：/.test(text)) return 'upstream_http';
  if (/请求失败或超时/.test(text)) return 'upstream_network';
  if (/接口未成功/.test(text)) return 'upstream_rejected';
  return 'internal';
}

export function publicSnapshot(value: Inspection): TaskSnapshot {
  return { exp: value.exp, coin: value.coin, tasks: taskIds.map(id => ({ id,
    state: (id === 'sign' ? value.signed : value.tasks.find(task => task.id === id)?.state === 'finish') ? 'finish' : 'waiting' })) };
}
async function checkpoint(job: Job) {
  if (job.date !== beijingDate()) throw new Error('cross_day');
  const response = await fetch(`${process.env.WEBSITE_URL}/internal/heartbeat`, { method: 'POST',
    headers: { authorization: `Bearer ${process.env.RUNNER_SERVICE_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: job.id, lease: job.lease, version: job.credential.version }), signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!response.ok) throw new Error('cancelled');
}
async function daily(job: Job): Promise<Outcome> {
  const config = decryptCredential(job.credential, process.env.CREDENTIAL_KEY || '');
  const client = new HeyboxClient(config);
  let before: InspectionSnapshot | undefined;
  let latest: InspectionSnapshot | undefined;
  try {
    const result = await runDaily(client, config.session.heybox_id, { log: () => {}, checkpoint: () => checkpoint(job),
      onSnapshot: value => { before ||= value; latest = value; } });
    await checkpoint(job);
    return { status: 'completed', expDelta: result.expDelta, coinDelta: result.coinDelta,
      profile: result.snapshot.profile, snapshot: publicSnapshot(result.snapshot) };
  } catch (error) {
    const text = error instanceof Error ? error.message : '';
    if (text === 'cancelled' || text === 'cross_day') return { status: 'cancelled', reason: text };
    if (/登录已过期|登录已失效|设备令牌无效/.test(text)) return { status: 'auth_expired', reason: 'auth_expired' };
    let snapshot: TaskSnapshot | undefined;
    try { await checkpoint(job); const state = await inspect(client, config.session.heybox_id); latest = state; snapshot = publicSnapshot(state); } catch { /* keep partial result optional */ }
    return { status: 'failed', reason: 'upstream', snapshot,
      expDelta: before && latest ? latest.exp - before.exp : undefined, coinDelta: before && latest ? latest.coin - before.coin : undefined };
  }
}
async function main() {
  let data = '';
  for await (const chunk of process.stdin) { data += chunk; if (data.length > 16_384) throw new Error('请求过大'); }
  const input = JSON.parse(data) as LoginInput | { action: 'daily'; job: Job };
  if (input.action === 'begin' || input.action === 'send' || input.action === 'verify') return loginStep(input);
  if (input.action === 'daily') return daily(jobSchema.parse(input.job));
  throw new Error('操作无效');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(value => process.stdout.write(JSON.stringify({ ok: true, value })), error => {
    const message = error instanceof Error ? error.message : '';
    const safe = /验证码.*(?:不正确|错误|过期)|频繁/.test(message) ? '验证码错误、过期或请求过于频繁，请核对后重试' : '小黑盒暂时无法完成登录，请稍后重试';
    const category = failureCategory(error);
    process.stdout.write(JSON.stringify({ ok: false, error: safe, category,
      code: category === 'captcha_required' ? category : undefined }));
  });
}
