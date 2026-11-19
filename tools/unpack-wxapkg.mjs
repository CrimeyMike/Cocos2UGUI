// wxapkg 解包工具：V1MMWX 解密 + wxapkg 容器解析（含嵌套子包递归）
// 用法: node unpack-wxapkg.mjs <wxapkg文件> <wxid> <输出目录>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [,, inputPath, wxid, outDir] = process.argv;
if (!inputPath || !wxid || !outDir) {
  console.error('用法: node unpack-wxapkg.mjs <wxapkg> <wxid> <outdir>');
  process.exit(1);
}

const IV = Buffer.from('the iv: 16 bytes');

function decrypt(buf, id) {
  // 与 zhuweiyou/wxapkg decrypt.go 一致：PBKDF2-SHA1 派生 32 字节密钥
  const key = crypto.pbkdf2Sync(id, 'saltiest', 1000, 32, 'sha1');
  const d = crypto.createDecipheriv('aes-256-cbc', key, IV);
  d.setAutoPadding(false);
  const head = d.update(buf.subarray(6, 6 + 1024));
  // 尾部用 wxid 倒数第二个字符作 XOR key
  const xorKey = id.length >= 2 ? id.charCodeAt(id.length - 2) : 0x66;
  const tail = buf.subarray(6 + 1024);
  const xored = Buffer.alloc(tail.length);
  for (let i = 0; i < tail.length; i++) xored[i] = tail[i] ^ xorKey;
  return Buffer.concat([head.subarray(0, 1023), xored]);
}

function isEncrypted(buf) { return buf.subarray(0, 6).toString('latin1') === 'V1MMWX'; }

function tryDecrypt(buf) {
  const candidates = [wxid, wxid.replace(/_[0-9a-f]{4}$/, '')];
  for (const id of candidates) {
    try {
      const out = decrypt(buf, id);
      if (out[0] === 0xbe && out[13] === 0xed) return { data: out, wxid: id };
    } catch { /* 密钥不匹配则尝试下一个候选 */ }
  }
  return null;
}

function parseWxapkg(buf) {
  if (buf[0] !== 0xbe || buf[13] !== 0xed) throw new Error('wxapkg 头部校验失败 (期望 0xBE...0xED)');
  let p = 14;
  const fileCount = buf.readUInt32BE(p); p += 4;
  const files = [];
  for (let i = 0; i < fileCount; i++) {
    const nameLen = buf.readUInt32BE(p); p += 4;
    const name = buf.subarray(p, p + nameLen).toString('utf8'); p += nameLen;
    const offset = buf.readUInt32BE(p); p += 4;
    const size = buf.readUInt32BE(p); p += 4;
    files.push({ name, offset, size });
  }
  return files;
}

function safeName(n) { return n.replace(/^\/+/, '').replaceAll('\\', '/').split('/').map(s => s.replace(/[<>:"|?*]/g, '_')).join('/'); }

let unpackedFiles = 0;

function unpackBuffer(buf, dest, label) {
  let plain = buf;
  let encNote = '明文';
  if (isEncrypted(buf)) {
    const r = tryDecrypt(buf);
    if (!r) throw new Error(`解密失败：两个候选 wxid 都无法产生合法 wxapkg 头 (${label})`);
    plain = r.data;
    encNote = `已解密 (wxid=${r.wxid})`;
  }
  const files = parseWxapkg(plain);
  fs.mkdirSync(dest, { recursive: true });
  let nested = [];
  for (const f of files) {
    const rel = safeName(f.name);
    const target = path.join(dest, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, plain.subarray(f.offset, f.offset + f.size));
    unpackedFiles++;
    if (/\.wxapkg$/i.test(f.name)) nested.push({ target, name: rel });
  }
  console.log(`[${label}] ${encNote}, ${files.length} 个文件${nested.length ? `，内含 ${nested.length} 个嵌套子包` : ''}`);
  for (const n of nested) {
    unpackBuffer(fs.readFileSync(n.target), path.join(dest, n.name.replace(/\.wxapkg$/i, '')), `${label}::${n.name}`);
  }
}

const buf = fs.readFileSync(inputPath);
unpackBuffer(buf, outDir, path.basename(inputPath));
console.log(`完成：共解出 ${unpackedFiles} 个文件 -> ${outDir}`);
