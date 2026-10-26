#!/usr/bin/env python3
"""Read the logged-in account from a USB-connected Android phone. No root needed."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser(description='从已登录小黑盒的 Android 手机导入配置')
parser.add_argument('--serial', help='多台设备连接时指定 adb serial')
parser.add_argument('--output', default='private/config.json')
args = parser.parse_args()
adb = ['adb'] + (['-s', args.serial] if args.serial else [])

def shell(*command):
    try:
        result = subprocess.run(adb + ['shell', *command], capture_output=True, text=True, timeout=20, check=True)
        return result.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        raise SystemExit('ADB 读取失败。请确认手机已连接、USB 调试已授权，且只选择了一台设备。')

package = shell('dumpsys', 'package', 'com.max.xiaoheihe')
version = re.search(r'versionName=([^\s]+)', package)
build = re.search(r'versionCode=(\d+)', package)
if not version or version[1] != '1.3.398' or not build or build[1] != '1142':
    raise SystemExit('当前只支持已验证的 APP 1.3.398 / build 1142。')
raw = shell('content', 'query', '--uri', 'content://com.max.xiaoheihe.statusprovider/login',
            '--projection', 'heybox_id:pkey:device_id:x_xhh_tokenid')
row = re.search(r'Row: \d+ (.*)', raw)
if not row:
    raise SystemExit('没有读到 APP 登录态，请先在手机登录小黑盒。')
parts = re.split(r', (?=(?:heybox_id|pkey|device_id|x_xhh_tokenid)=)', row[1])
fields = dict(part.split('=', 1) for part in parts)
keys = ('heybox_id', 'pkey', 'device_id', 'x_xhh_tokenid')
if any(not fields.get(key) or fields[key] == 'NULL' for key in keys):
    raise SystemExit('APP 登录态不完整，请重新登录后再导入。')
config = {
    'session': {key: fields[key] for key in keys},
    'device': {'model': shell('getprop', 'ro.product.model'), 'osVersion': shell('getprop', 'ro.build.version.release')},
    'app': {'version': version[1], 'build': build[1], 'shaderVersion': '14'},
}
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.fchmod(fd, 0o600)
with os.fdopen(fd, 'w') as stream:
    json.dump(config, stream, ensure_ascii=False, indent=2)
    stream.write('\n')
print('配置已保存至 ' + str(output) + '，未输出账号凭据。')
