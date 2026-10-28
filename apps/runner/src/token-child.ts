import { getDeviceToken, prepareDeviceToken } from 'heybox-daily/device-token';
import { LoginTiming } from '@heybox/contracts';
import { tokenDiagnostic } from './token-diagnostic.ts';

const timing = new LoginTiming();
const generate = () => getDeviceToken({ onTiming: (stage, duration) => timing.add(stage, duration) });

const send = (value: object, code?: number) => {
  if (process.send) process.send(value, () => { if (code !== undefined) process.exit(code); });
  else process.stdout.write(JSON.stringify(value), () => process.exit(code ?? 0));
};
const fail = (error: unknown) => send({ type: 'error', diagnostic: tokenDiagnostic(error), timing: timing.header() }, 1);
if (process.send) {
  try {
    await prepareDeviceToken();
    process.once('message', value => {
      if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'generate') { fail(undefined); return; }
      generate().then(token => send({ type: 'token', token, timing: timing.header() }, 0), fail);
    });
    send({ type: 'ready' });
  } catch (error) { fail(error); }
} else generate().then(token => send({ token, timing: timing.header() }, 0), fail);
