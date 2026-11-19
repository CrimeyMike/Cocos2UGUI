// map-tests/lib.mjs — 零框架单测辅助(被各 t*.mjs 复用)
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.dirname(path.dirname(DIR));  // 仓库根
export const BUILD = path.join(ROOT, 'build');

export function loadBuild(panel) {
  const f = path.join(BUILD, panel + '.build.json');
  if (!fs.existsSync(f)) throw new Error(`缺少本地面板数据 ${f} (golden 测试需自备 ir/build 数据, 版权原因不入库)`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
// 按路径段查找节点; 段也可以只给一个叶名(取 DFS 首个匹配)
export function findNode(root, ...segments) {
  let cur = root;
  for (const seg of segments) {
    const next = (cur.children || []).find(c => c.name === seg);
    if (!next) throw new Error(`找不到节点 ${seg} (路径 ${segments.join('/')}, 父 ${cur.name})`);
    cur = next;
  }
  return cur;
}
export function comp(node, type) {
  return (node.components || []).find(c => c.type === type) || null;
}
export function sprite(build, name) {
  return build.sprites.find(s => s.name === name) || null;
}
export function near(a, b, msg, eps = 1e-3) {
  if (Array.isArray(a) && Array.isArray(b)) {
    assert.equal(a.length, b.length, `${msg}: 长度 ${a} vs ${b}`);
    a.forEach((v, i) => near(v, b[i], `${msg}[${i}]`, eps));
    return;
  }
  if (Math.abs(a - b) > eps) assert.fail(`${msg}: ${a} != ${b} (±${eps})`);
}
export function deepEqual(a, b, msg) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) assert.fail(`${msg}:\n  实际 ${ja}\n  期望 ${jb}`);
}
