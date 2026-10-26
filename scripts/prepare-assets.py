#!/usr/bin/env python3
"""Extract the shared signing assets; no account or device data is needed."""
import argparse
import hashlib
from pathlib import Path
import zipfile

parser = argparse.ArgumentParser(description='从 APP 安装包和配套 shader 文件准备签名资源')
parser.add_argument('--apk', required=True, help='小黑盒 1.3.398 / build 1142 的 base.apk')
parser.add_argument('--shader', required=True, help='与该版本匹配的 shader-code.bin（版本 14）')
parser.add_argument('--output', default='private/assets')
args = parser.parse_args()
expected = {
    'libnative-lib.so': '5d8699f237ab12582f3d9b22c23c3edb91f9f65bca3ac1211c36e25fdb069489',
    'libglesv3_1.so': '5ff6850b0b682418bf62be178acb481119be042a7297c1f3bdf47666dca86344',
    'shader-code.bin': '05d39913b3cfe0345e6cb86d44ce21e1e67a325cf428b8f613d1774f9b2067ea',
}
try:
    with zipfile.ZipFile(args.apk) as apk:
        data = {name: apk.read('lib/arm64-v8a/' + name) for name in expected if name.endswith('.so')}
        metadata = {name: apk.read(name) for name in ['AndroidManifest.xml', 'META-INF/MAXJIA.RSA']}
    data['shader-code.bin'] = Path(args.shader).read_bytes()
    for name, value in data.items():
        if hashlib.sha256(value).hexdigest() != expected[name]:
            raise ValueError('资源版本不匹配：' + name)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output / 'app-metadata.apk', 'w') as apk:
        for name, value in metadata.items():
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            apk.writestr(entry, value)
    for name, value in data.items():
        (output / name).write_bytes(value)
except (OSError, KeyError, ValueError, zipfile.BadZipFile) as error:
    raise SystemExit('准备失败：' + str(error))
print('签名资源已准备至 ' + str(output))
