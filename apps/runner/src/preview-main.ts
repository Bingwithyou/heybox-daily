import { createPreviewRunner } from './preview.ts';
const server = createPreviewRunner({
  token: process.env.RUNNER_SERVICE_TOKEN || '', key: process.env.CREDENTIAL_KEY || '',
  websiteUrl: process.env.WEBSITE_URL || '',
});
server.listen(Number(process.env.PORT || 8788), process.env.HOST || '127.0.0.1', () => {
  console.log(JSON.stringify({ event: 'preview_runner_listening', mode: 'synthetic-only' }));
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { server.close(); });
