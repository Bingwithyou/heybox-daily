import { getDeviceToken, prepareDeviceToken, DeviceTokenError } from 'heybox-daily/device-token';

const send = (value: object, code?: number) => {
  if (process.send) process.send(value, () => { if (code !== undefined) process.exit(code); });
  else process.stdout.write(JSON.stringify(value), () => process.exit(code ?? 0));
};
const fail = (error: unknown) => send({ type: 'error', stage: error instanceof DeviceTokenError ? error.stage : 'initialize' }, 1);
if (process.send) {
  try {
    await prepareDeviceToken();
    process.once('message', value => {
      if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'generate') { fail(undefined); return; }
      getDeviceToken().then(token => send({ type: 'token', token }, 0), fail);
    });
    send({ type: 'ready' });
  } catch (error) { fail(error); }
} else getDeviceToken().then(token => send({ token }, 0), fail);
