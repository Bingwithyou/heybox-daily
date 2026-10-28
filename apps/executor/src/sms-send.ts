import { LoginFailure } from '@heybox/contracts';
import { privateKey } from '@heybox/hosting/security';
import type { Store } from '@heybox/hosting/store';
import type { LoginStep } from '@heybox/hosting/login';

export async function sendWithCooldown(store: Pick<Store, 'acquireSmsSend' | 'finishSmsSend'>,
  secret: string, phone: string, send: () => Promise<LoginStep>): Promise<LoginStep> {
  const key = await privateKey(`sms-send:${phone}`, secret);
  const admission = await store.acquireSmsSend(key);
  if (!admission.token) throw new LoginFailure('sms_cooldown', admission.retryAt);
  let possiblySent = true;
  try {
    const result = await send();
    possiblySent = result.status !== 'captcha';
    return result;
  } finally {
    // If cleanup fails, the original bounded reservation stays closed. Never retry the SMS.
    await store.finishSmsSend(key, admission.token, possiblySent);
  }
}
