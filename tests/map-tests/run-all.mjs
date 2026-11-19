#!/usr/bin/env node
// run-all.mjs — golden 测试入口: 重新生成 build 产物 → 跑全部 t*.mjs → validate-build
// 退出码: 0 = 全绿, 1 = 有失败。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(path.dirname(DIR));  // 仓库根
const tmpBuild = path.join(DIR, '.tmp-synthetic.build.json');
const TOOLS = path.join(ROOT, 'tools');
// golden 回归测试基于真实面板数据(版权原因不入库): 把你自己的
// ir/*.json 放 <仓库根>/ir/ 后自动启用; 无本地数据时只跑 synthetic 基线。
const HAS_LOCAL = fs.existsSync(path.join(ROOT, 'ir', 'demo-pfb_demo_guide.json'));

function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8' });
  const ok = r.status === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok || r.stdout?.trim()) process.stdout.write((r.stdout || '').split('\n').map(l => '     ' + l).join('\n') + '\n');
  if (!ok && r.stderr?.trim()) process.stderr.write((r.stderr || '').split('\n').map(l => '     ' + l).join('\n') + '\n');
  return ok;
}

let pass = 0, fail = 0;

// 0) 重新生成三个面板 + 合成样例
const gens = [  ];
if (HAS_LOCAL) {
  gens.push(
    ['node', [path.join(TOOLS, 'map-to-ugui.mjs'), path.join(ROOT, 'ir', 'demo-pfb_demo_guide.json')], '生成 guide build'],
    ['node', [path.join(TOOLS, 'map-to-ugui.mjs'), path.join(ROOT, 'ir', 'demo-demo_rank_reward.json')], '生成 home build'],
    ['node', [path.join(TOOLS, 'map-to-ugui.mjs'), path.join(ROOT, 'ir', 'demo-ui-demo_statistic_view.json')], '生成 battle build'],
  );
}
gens.push(['node', [path.join(TOOLS, 'map-to-ugui.mjs'), path.join(DIR, 'fixture-synthetic.json'), '--out', tmpBuild], '生成 synthetic build']);
for (const [cmd, args, label] of gens) { run(cmd, args, label) ? pass++ : fail++; }

// 1) golden 测试(依赖真实面板; 无本地数据时仅跑 synthetic 基线 t9)
const tests = fs.readdirSync(DIR).filter(f => /^t\d+-.*\.mjs$/.test(f)).sort()
  .filter(t => HAS_LOCAL || t.startsWith('t9-'));
if (!HAS_LOCAL && tests.length === 0) console.log('skip golden 回归(无本地 ir/ 数据, 详见 README)');
for (const t of tests) {
  run('node', [path.join(DIR, t)], t) ? pass++ : fail++;
}

// 2) 三个面板过校验器(带 IR 对照)
if (HAS_LOCAL) {
  const panels = ['demo-pfb_demo_guide', 'demo-demo_rank_reward', 'demo-ui-demo_statistic_view'];
  for (const p of panels) {
    run('node', [path.join(TOOLS, 'validate-build.mjs'), path.join(ROOT, 'build', `${p}.build.json`), path.join(ROOT, 'ir', `${p}.json`)], `validate ${p}`) ? pass++ : fail++;
  }
}
run('node', [path.join(TOOLS, 'validate-build.mjs'), tmpBuild, path.join(DIR, 'fixture-synthetic.json')], 'validate synthetic') ? pass++ : fail++;

fs.rmSync(tmpBuild, { force: true });
console.log('─'.repeat(60));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
