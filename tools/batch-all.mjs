#!/usr/bin/env node
// ============================================================================
// batch-all.mjs — P6 批量驱动: 枚举 gamecaches 全部 cc.Prefab 资产,
// 逐个调用 parse-prefab.mjs (P1) 与 map-to-ugui.mjs (P3), 产出
//   ir-all/<bundle>-<name>.json        (P1 中间表示)
//   build/<bundle>-<name>.build.json   (P3 UGUI 构建描述)
// 以及 batch-report.json (逐面板结果 + 汇总)。
//
// 用法: node batch-all.mjs [--gamecaches <dir>] [--only <bundle>] [--limit N]
// 注: 幂等——已存在的 build.json 默认跳过(--force 重跑)。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { GameCaches } from './parse-prefab.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// 微信小游戏缓存根目录(各机器不同), 必须显式提供:
//   Windows 示例: <xwechat数据目录>/radium/users/<用户哈希>/applet/local/<appid>/usr/gamecaches
const GC_DEFAULT = null;

const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const gcRoot = argOf('--gamecaches') ?? process.env.C2U_GAMECACHES ?? GC_DEFAULT;
const onlyBundle = argOf('--only');
const limit = argOf('--limit') ? parseInt(argOf('--limit'), 10) : Infinity;
const force = args.includes('--force');

const panelOwner = new Map();   // meta.panel -> uuid（撞名检测）
const IR_DIR = path.join(here, 'ir-all');
const BUILD_DIR = path.join(here, 'build');
fs.mkdirSync(IR_DIR, { recursive: true });
fs.mkdirSync(BUILD_DIR, { recursive: true });

if (!gcRoot) {
  console.error('缺少 --gamecaches <目录> 参数(或环境变量 C2U_GAMECACHES)。指向微信小游戏的 gamecaches 缓存根目录。');
  process.exit(2);
}

const safeName = (s) => String(s).replace(/[^0-9A-Za-z_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';

// ---------- 1. 枚举 prefab ----------
const gc = new GameCaches(gcRoot);
const prefabs = [];
const seenUuid = new Set();  // 同一 uuid 可能在多个 bundle 的 config 各登记一次（共享资产缓存副本），只取首个
for (const bn of gc.bundleNames()) {
  if (onlyBundle && bn !== onlyBundle) continue;
  const b = gc.bundle(bn);
  if (!b) continue;
  const uuids = b.config.uuids || [];
  for (const uuid of uuids) {
    if (typeof uuid !== 'string' || uuid.includes('@')) continue; // @ 子资产(图集帧)非独立资产
    if (seenUuid.has(uuid)) continue;
    const loc = gc.locate(uuid, bn);
    if (!loc || !fs.existsSync(loc.file)) continue;
    let d;
    try { d = gc.loadDecoded(uuid, bn); } catch { continue; }
    if (!d || d.kind !== 'prefab') continue;
    seenUuid.add(uuid);
    const rawName = gc.assetName(uuid, bn) || uuid;
    prefabs.push({ bundle: bn, uuid, name: safeName(rawName), file: loc.file, section: loc.section ?? 0 });
  }
}
console.log(`枚举完成: ${prefabs.length} 个唯一 prefab（gamecaches=${gcRoot}）`);

// ---------- 2. 逐个 P1 + P3 ----------
const results = [];
let done = 0, parseFail = 0, mapFail = 0, skipped = 0;
const t0 = Date.now();
for (const p of prefabs) {
  if (done >= limit) break;
  const panelId = `${p.bundle}-${p.name}`;
  const irPath = path.join(IR_DIR, panelId + '.json');
  const buildPath = path.join(BUILD_DIR, panelId + '.build.json');
  const row = { panel: panelId, bundle: p.bundle, name: p.name, uuid: p.uuid };

  if (!force && fs.existsSync(buildPath)) {
    row.status = 'skipped-exists';
    skipped++; done++;
    results.push(row);
    continue;
  }

  // P1 解析
  const r1 = spawnSync(process.execPath, [path.join(here, 'parse-prefab.mjs'), p.file,
    '--section', String(p.section), '--gamecaches', gcRoot, '--bundle', p.bundle, '--out', irPath],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r1.status !== 0) {
    row.status = 'parse-fail';
    row.error = (r1.stderr || r1.stdout || '').split('\n').filter(Boolean).slice(-3).join(' | ');
    parseFail++; done++;
    results.push(row);
    console.log(`[FAIL-P1] ${panelId}: ${row.error}`);
    continue;
  }
  // P3 映射
  const r2 = spawnSync(process.execPath, [path.join(here, 'map-to-ugui.mjs'), irPath, '--out', buildPath],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r2.status !== 0) {
    row.status = 'map-fail';
    row.error = (r2.stderr || r2.stdout || '').split('\n').filter(Boolean).slice(-3).join(' | ');
    mapFail++; done++;
    results.push(row);
    console.log(`[FAIL-P3] ${panelId}: ${row.error}`);
    continue;
  }
  // 从 map 输出摘要抓统计行: "nodes=100" / "unmapped=35" / "flags=[...]"
  const out = r2.stdout || '';
  // meta.panel 来自 prefab 根节点名(map-to-ugui 内部)，可能与本批其他面板撞名 —— 冲突时追加 uuid 短后缀
  let bj;
  try { bj = JSON.parse(fs.readFileSync(buildPath, 'utf8')); } catch (e) {
    row.status = 'map-fail'; row.error = 'build.json 重读失败: ' + e.message;
    mapFail++; done++; results.push(row); continue;
  }
  let panel = bj.meta.panel;
  if (panelOwner.has(panel)) {
    panel = panel + '-' + p.uuid.slice(-6);
    bj.meta.panel = panel;
    const finalPath = path.join(BUILD_DIR, panel + '.build.json');
    fs.rmSync(buildPath, { force: true });
    fs.writeFileSync(finalPath, JSON.stringify(bj));
  }
  panelOwner.set(panel, p.uuid);
  row.panel = panel;
  row.status = 'ok';
  row.nodes = Number((out.match(/nodes=(\d+)/) || [])[1] ?? 0);
  row.unmapped = Number((out.match(/unmapped=(\d+)/) || [])[1] ?? 0);
  row.flags = (out.match(/flags=\[([^\]]*)\]/) || [])[1] || '';
  done++;
  results.push(row);
  if (done % 20 === 0) console.log(`进度 ${done}/${prefabs.length}（${Math.round((Date.now() - t0) / 1000)}s）`);
}

const summary = {
  generatedAt: new Date().toISOString(),
  gamecaches: gcRoot,
  totalPrefabs: prefabs.length,
  processed: done,
  ok: results.filter(r => r.status === 'ok').length,
  parseFail, mapFail, skipped,
  durationMs: Date.now() - t0,
  panels: results,
};
fs.writeFileSync(path.join(here, 'batch-report.json'), JSON.stringify(summary, null, 1));
console.log(`\n批量完成: 总数=${prefabs.length} ok=${summary.ok} 解析失败=${parseFail} 映射失败=${mapFail} 跳过=${skipped} 耗时=${(summary.durationMs / 1000).toFixed(1)}s`);
console.log('报告: ' + path.join(here, 'batch-report.json'));
