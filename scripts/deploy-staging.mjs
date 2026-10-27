import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const web = resolve(root, 'apps/web');
const buildOnly = process.argv.includes('--build-only');
if (process.argv.slice(2).some(arg => arg !== '--build-only')) throw new Error('仅支持 --build-only');
function run(file, args, env = process.env) {
  const result = spawnSync(process.execPath, [resolve(web, file), ...args], { cwd: web, env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`命令失败: ${file} (${result.status})`);
}

// A dedicated empty file prevents the Vite plugin from embedding local .dev.vars secrets.
const vars = resolve(web, '.dev.vars.staging');
if (existsSync(vars)) throw new Error('请先移走 apps/web/.dev.vars.staging；发布构建不读取本地密钥。');
writeFileSync(vars, '# Staging secrets are managed remotely.\n', { flag: 'wx', mode: 0o600 });
try {
  run('node_modules/vite-plus/bin/vp', ['build', '--mode', 'staging'], {
    ...process.env, CLOUDFLARE_ENV: 'staging',
  });
} finally { unlinkSync(vars); }

const configPath = resolve(web, 'dist/server/wrangler.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
assert.equal(config.name, 'heybox-daily-staging');
assert.deepEqual(config.routes, [{ pattern: 'preview.heybox.cansiny.top', custom_domain: true }]);
assert.equal(config.d1_databases?.length, 1);
assert.equal(config.d1_databases[0].database_id, '4330a4a2-af40-41df-9048-aa2db3c45df0');
assert.equal(config.d1_databases[0].database_name, 'heybox-daily-staging');
assert.deepEqual(config.triggers?.crons || [], []);
assert.deepEqual(config.vars, {
  DEPLOYMENT_ENV: 'staging', SITE_URL: 'https://preview.heybox.cansiny.top',
  RUNNER_URL: 'https://heybox-preview-runner.cansiny.top',
});
assert.equal(config.workers_dev, false);
console.log('Staging target verified: isolated Worker, D1, domain; no cron or embedded secrets.');
if (!buildOnly) run('node_modules/wrangler/bin/wrangler.js', ['deploy', '--config', configPath]);
