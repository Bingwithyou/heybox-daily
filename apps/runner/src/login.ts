import { prepareLogin, sendLoginCode, verifyLoginCode } from 'heybox-daily/login';
import { HeyboxApiError } from 'heybox-daily/client';
import type { Config } from 'heybox-daily/types';
import type { CaptchaProof } from '@heybox/contracts';
import type { LoginStep } from './challenges.ts';

export type LoginInput = { action: 'begin'; phone: string }
  | { action: 'send'; config: Config; phone: string; proof: CaptchaProof }
  | { action: 'verify'; config: Config; phone: string; code: string; proof?: CaptchaProof };
export async function loginStep(input: LoginInput): Promise<LoginStep> {
  const config = input.action === 'begin' ? await prepareLogin() : input.config;
  try {
    if (input.action === 'verify') return { status: 'authenticated',
      config: await verifyLoginCode(config, input.phone, input.code, { captcha: input.proof }) };
    await sendLoginCode(config, input.phone, { captcha: input.action === 'send' ? input.proof : undefined });
    return { status: 'sent', config };
  } catch (error) {
    if (error instanceof HeyboxApiError && error.captchaRequired && error.captchaAppId)
      return { status: 'captcha', appId: error.captchaAppId, config };
    throw error;
  }
}
