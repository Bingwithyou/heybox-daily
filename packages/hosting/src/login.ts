import type { Config } from 'heybox-daily/types';
export type LoginStep = { status: 'sent' | 'authenticated'; config: Config } | { status: 'captcha'; appId: string; config: Config };
