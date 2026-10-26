import { webSignature } from './signature.js';
import { nativeSignature } from './native.js';
import { encryptReport } from './report.js';

export class HeyboxClient {
  constructor(config, { fetchImpl = fetch, signer = nativeSignature } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.signer = signer;
  }

  async request(host, endpoint, query, headers, body) {
    let response;
    try {
      response = await this.fetch(`https://${host}${endpoint}?${new URLSearchParams(query)}`, {
        method: body ? 'POST' : 'GET', headers, body,
        redirect: 'error', signal: AbortSignal.timeout(20000),
      });
    } catch { throw new Error(`请求失败或超时：${endpoint}`); }
    if (!response.ok) throw new Error(`HTTP ${response.status}：${endpoint}`);
    let data;
    try { data = await response.json(); } catch { throw new Error(`接口返回了非 JSON 内容：${endpoint}`); }
    if (data.status === 'relogin') throw new Error('APP 登录已过期，请重新导入手机登录态');
    // Avoid logging server messages or URLs: they may contain account data.
    if (data.status !== 'ok') throw new Error(`接口未成功：${endpoint}`);
    return data.result;
  }

  web(endpoint, extra = {}, { host = 'api.xiaoheihe.cn', body } = {}) {
    const { session, device, app } = this.config;
    const query = {
      app: 'heybox', os_type: 'web', x_app: 'heybox', x_client_type: 'web', x_os_type: 'Android',
      x_client_version: app.version, version: '999.0.4', heybox_id: session.heybox_id,
      ...extra, ...webSignature(endpoint),
    };
    const headers = {
      'User-Agent': `Mozilla/5.0 (Linux; Android ${device.osVersion}; ${device.model}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/143.0.7499.192 Mobile Safari/537.36`,
      Accept: 'application/json, text/plain, */*', Origin: 'https://web.xiaoheihe.cn',
      Referer: 'https://web.xiaoheihe.cn/', 'X-Requested-With': 'com.max.xiaoheihe',
      Cookie: `pkey=${session.pkey};x_xhh_tokenid=${session.x_xhh_tokenid};x_pkey=${session.pkey};x_heybox_id=${session.heybox_id}`,
    };
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    return this.request(host, endpoint, query, headers, body);
  }

  native(endpoint) {
    const { session, device, app } = this.config;
    return this.request('api.xiaoheihe.cn', endpoint, {
      heybox_id: session.heybox_id, imei: session.device_id, device_info: device.model,
      os_type: 'Android', x_os_type: 'Android', x_client_type: 'mobile', os_version: device.osVersion,
      version: app.version, build: app.build, dw: '360', channel: 'heybox', x_app: 'heybox', time_zone: 'Asia/Shanghai',
      ...this.signer(endpoint, this.config),
    }, { 'User-Agent': 'Max-Android', Accept: 'application/json', Cookie: `pkey=${session.pkey}; x_xhh_tokenid=${session.x_xhh_tokenid}` });
  }

  tasks() { return this.web('/task/list_v2/'); }
  signState() { return this.native('/task/sign_v4/get_sign_state'); }
  sign() { return this.native('/task/sign_v3/sign'); }
  report(event, sessionId) {
    const { data, key, sid, time } = encryptReport([event]);
    return this.web('/account/data_report/', { type: '104', time_: time, session_id: sessionId }, {
      host: 'data.xiaoheihe.cn', body: new URLSearchParams({ data, key, sid }),
    });
  }
}
