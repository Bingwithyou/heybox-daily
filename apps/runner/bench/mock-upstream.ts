// Imported only by the isolated benchmark's child processes. Never forwards network requests.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const resultDirectory = process.env.HEYBOX_BENCH_RESULTS;
if (!resultDirectory) throw new Error('Only run through bench/task-concurrency.ts');
let signed = false; let reports = 0; let requests = 0;
const finished = new Set<string>();
const shares = ['1', '19', '31'];
globalThis.fetch = async input => {
  const url = new URL(String(input));
  requests++;
  if (url.origin === 'https://benchmark.invalid' && url.pathname === '/internal/heartbeat') {
    return new Response(null, { status: 204 });
  }
  assert.ok(['api.xiaoheihe.cn', 'data.xiaoheihe.cn'].includes(url.hostname), 'unexpected network destination');
  assert.ok(url.searchParams.get('hkey')); assert.ok(url.searchParams.get('nonce')); assert.ok(url.searchParams.get('_time'));
  await setTimeout(50); // Simulated upstream latency; production task sleeps are left unchanged.
  let result: unknown;
  switch (url.pathname) {
    case '/task/list_v2/':
      result = { user: { userid: url.searchParams.get('heybox_id'), username: 'Benchmark',
        level_info: { exp: 100 + (signed ? 1 : 0) + finished.size * 3, coin: signed ? 100 : 0, level: 1, max_exp: 1000 } },
      task_list: [{ title: '每日任务', tasks: shares.map(id => ({ report_extra: { task_id: id }, state: finished.has(id) ? 'finish' : 'waiting' })) }] };
      break;
    case '/task/sign_v4/get_sign_state':
      result = { state: signed ? 'ok' : 'waiting', signed_date: signed ? Math.floor((Date.now() / 1000 + 8 * 3600) / 86400) : 0 };
      break;
    case '/task/sign_v3/sign': signed = true; result = {}; break;
    case '/bbs/app/feeds': result = { links: [{ linkid: '123', h_src: 'benchmark' }] }; break;
    case '/game/all_recommend/v2': result = { games: [{ appid: '456', h_src: 'benchmark' }] }; break;
    case '/bbs/app/link/game/comments': result = { links: [{ linkid: '789', userid: '100' }] }; break;
    case '/game/comment/share_data/': result = { comment_detail: { linkid: '789' } }; break;
    case '/account/data_report/':
      reports++;
      if (reports % 3 === 0) finished.add(shares[reports / 3 - 1]);
      result = {}; break;
    default: throw new Error(`Unexpected mock endpoint: ${url.pathname}`);
  }
  return Response.json({ status: 'ok', result });
};
process.on('exit', () => {
  writeFileSync(join(resultDirectory, `${process.pid}.json`), JSON.stringify({ cpu: process.cpuUsage(),
    maxRssKiB: process.resourceUsage().maxRSS, requests, signed, shares: finished.size }));
});
