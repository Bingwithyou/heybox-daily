import { prepareLogin, sendLoginCode, verifyLoginCode } from 'heybox-daily/login';
import { HeyboxApiError, HeyboxClient } from 'heybox-daily/client';
import type { Config } from 'heybox-daily/types';
import type { CaptchaProof } from '@heybox/contracts';
import type { LoginStep } from './challenges.ts';
import { createLoginFetch } from './login-relay.ts';

export type LoginInput = { action: 'begin'; phone: string }
  | { action: 'send'; config: Config; phone: string; proof: CaptchaProof }
  | { action: 'verify'; config: Config; phone: string; code: string; proof?: CaptchaProof };
export async function loginStep(input: LoginInput): Promise<LoginStep> {
  const fetchImpl = createLoginFetch();
  const clientFactory = (config: Config) => new HeyboxClient(config, { fetchImpl });
  const config = input.action === 'begin' ? await prepareLogin() : input.config;
  try {
    if (input.action === 'verify') return { status: 'authenticated',
      config: await verifyLoginCode(config, input.phone, input.code, { clientFactory, captcha: input.proof }) };
    await sendLoginCode(config, input.phone, { clientFactory, captcha: input.action === 'send' ? input.proof : undefined });
    return { status: 'sent', config };
  } catch (error) {
    if (error instanceof HeyboxApiError && error.captchaRequired && error.captchaAppId)
      return { status: 'captcha', appId: error.captchaAppId, config };
    throw error;
  }
}
