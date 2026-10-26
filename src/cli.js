import { loadConfig } from './config.js';
import { HeyboxClient } from './client.js';
import { inspect, runDaily } from './tasks.js';

const command = process.argv[2] || 'check';
try {
  if (['--help', '-h', 'help'].includes(command)) {
    console.log('用法：node src/cli.js check|run\ncheck 只查看状态；run 完成当天未完成的签到与三项分享任务。');
  } else {
    if (!['check', 'run'].includes(command)) throw new Error('命令应为 check 或 run');
    const config = loadConfig();
    const client = new HeyboxClient(config);
    if (command === 'check') {
      const state = await inspect(client, config.session.heybox_id);
      console.log(`签到：${state.signed ? '今天已完成' : '今天未完成'}`);
      for (const task of state.tasks.filter(task => ['1', '19', '31'].includes(task.id))) {
        console.log(`${task.title}：${task.state === 'finish' ? '已完成' : '未完成'}`);
      }
      console.log(`经验 ${state.exp}，H 币 ${state.coin}`);
    } else {
      const summary = await runDaily(client, config.session.heybox_id);
      console.log(`今日任务已完成，本次经验 +${summary.expDelta}，H 币 +${summary.coinDelta}`);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
