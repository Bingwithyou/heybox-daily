import { getDeviceToken, DeviceTokenError } from 'heybox-daily/device-token';

getDeviceToken().then(token => process.stdout.write(JSON.stringify({ token })), error => {
  process.stdout.write(JSON.stringify({ error: 'device_token_failed', stage: error instanceof DeviceTokenError ? error.stage : 'internal' }));
  process.exitCode = 1;
});
