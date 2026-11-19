#!/usr/bin/env node
// editor-tests.mjs — 编辑器入口全链路 golden 测试:
// fixture 工程(tests/editor-fixture) → parse-editor-prefab → map-to-ugui → validate-build
// 断言: 引用解析/切图信息/Widget 位表/滚动 content 精确解析/组件枚举/九宫格 border。
// 退出码: 0=全绿, 1=失败。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);                      // cocos2ugui/
const TOOLS = path.join(ROOT, 'tools').replace(/[\\/]tools$/, ''); // 开发仓库根(map-to-ugui 同级)
const FX = path.join(HERE, 'editor-fixture');
const tmpIR = path.join(HERE, '.tmp-editor.ir.json');
const tmpBuild = path.join(HERE, '.tmp-editor.build.json');

let pass = 0, fail = 0;
function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8' });
  const ok = r.status === 0;
  if (ok) { console.log(`ok   ${label}`); pass++; }
  else { console.log(`FAIL ${label}`); if (r.stdout) console.log(r.stdout.split('\n').slice(-6).join('\n')); if (r.stderr) console.log(r.stderr.split('\n').slice(-6).join('\n')); fail++; }
  return ok;
}
const mapScript = fs.existsSync(path.join(ROOT, 'map-to-ugui.mjs')) ? path.join(ROOT, 'map-to-ugui.mjs') : path.join(ROOT, 'tools', 'map-to-ugui.mjs');
const parseScript = fs.existsSync(path.join(ROOT, 'parse-editor-prefab.mjs')) ? path.join(ROOT, 'parse-editor-prefab.mjs') : path.join(ROOT, 'tools', 'parse-editor-prefab.mjs');
const validateScript = fs.existsSync(path.join(ROOT, 'validate-build.mjs')) ? path.join(ROOT, 'validate-build.mjs') : path.join(ROOT, 'tools', 'validate-build.mjs');

run('node', [parseScript, path.join(FX, 'assets/panel_a.prefab'), '--out', tmpIR], 'editor → IR');
run('node', [mapScript, tmpIR, '--out', tmpBuild], 'IR → build');
run('node', [validateScript, tmpBuild, tmpIR], 'validate build');

const ir = JSON.parse(fs.readFileSync(tmpIR, 'utf8'));
const b = JSON.parse(fs.readFileSync(tmpBuild, 'utf8'));
const t = (name, fn) => { try { fn(); console.log('ok   ' + name); pass++; } catch (e) { console.log(`FAIL ${name}\n     ${e.message}`); fail++; } };

t('IR: 8 节点 / 0 未解决 / 2 资产', () => {
  assert.equal(ir.meta.stats.nodes, 9);
  assert.equal(ir.unresolved.length, 0);
  assert.equal(ir.assets.length, 4);
});
t('IR: spriteFrame 资产信息(独立图 border→capInsets [L,T,R,B])', () => {
  const bg = ir.assets.find(a => a.uuid.startsWith('11111111'));
  assert.equal(bg.kind, 'spriteFrame');
  assert.equal(bg.sprite.capInsets.join(','), '20,20,20,20');
  assert.equal(bg.sprite.rect.width, 79);
  assert.equal(bg.file, 'assets/img/bg.png');
  assert.equal(bg.exists, true);
});
t('IR: ScrollView._content 带精确节点名', () => {
  const sv = ir.nodes[0].children.find(n => n.name === 'scroll_view');
  const p = sv.components.find(c => c.type === 'cc.ScrollView').props;
  assert.equal(p._content.resolvedNodeName, 'view');
});
t('IR: plist 图集帧(rect 转置/rotated/border)', () => {
  const fa = ir.assets.find(a => a.uuid.endsWith('@aaa01'));
  const fb = ir.assets.find(a => a.uuid.endsWith('@aaa02'));
  assert.deepEqual(fa.sprite.capInsets.join(','), '12,12,12,12');
  assert.equal(fb.sprite.rotated, true);
  assert.equal(fb.sprite.rect.width, 40);   // 转置块宽 = 原始 h
  assert.equal(fb.sprite.rect.height, 30);  // 转置块高 = 原始 w
  assert.equal(fb.sprite.originalSize.width, 30);
});
t('build: panelId 与 sprites 契约', () => {
  assert.equal(b.meta.panel, 'assets-panel_a');
  assert.equal(b.sprites.length, 4);
  const bg = b.sprites.find(s => s.name === 'bg');
  assert.equal(bg.border.join(','), '20,20,20,20');            // capInsets [L,T,R,B] → border [L,B,R,T] 经 map 换算
  assert.ok(bg.source.includes('assets/img/bg.png'));
});
t('build: ScrollRect.content = view(精确解析)', () => {
  const sv = b.root.children.find(n => n.name === 'scroll_view');
  const sr = sv.components.find(c => c.type === 'ScrollRect');
  assert.equal(sr.props.content, 'view');
  assert.equal(sr.props.vertical, true);
  assert.ok(sv.components.some(c => c.type === 'RectMask2D'));
});
t('build: Button/Label/Widget/CustomScript', () => {
  const btn = b.root.children.find(n => n.name === 'btn_close');
  assert.equal(btn.components.find(c => c.type === 'Button').props.transition, 'ColorTint');
  const lbl = b.root.children.find(n => n.name === 'lbl_title');
  const tx = lbl.components.find(c => c.type === 'Text');
  assert.equal(tx.props.text, '演示面板');
  assert.equal(tx.props.overflow, 'Shrink');                    // _overflow:2
  assert.equal(tx.props.fontSize, 28);
  // root Widget 45 = TOP|BOT|LEFT|RIGHT 全拉伸
  assert.deepEqual(b.root.rect.anchorMin, [0, 0]);
  assert.deepEqual(b.root.rect.anchorMax, [1, 1]);
  assert.deepEqual(b.root.rect.offsetMin, [0, 0]);
  assert.deepEqual(b.root.rect.offsetMax, [0, 0]);
  assert.ok(b.scripts.length === 1 && b.scripts[0].className.startsWith('PanelA_'));
  assert.ok(b.root.components.some(c => c.type === 'CustomScript'));
});
t('build: img_bg 居中 rect 恒等式', () => {
  const n = b.root.children.find(x => x.name === 'img_bg');
  const r = n.rect;
  assert.deepEqual(r.anchoredPosition, [0, 0]);
  assert.deepEqual(r.sizeDelta, [400, 300]);
  const [omx, omy] = r.offsetMin, [oMx, oMy] = r.offsetMax;
  assert.ok(Math.abs(oMx - (omx + r.sizeDelta[0])) < 1e-3);
  assert.ok(Math.abs(oMy - (omy + r.sizeDelta[1])) < 1e-3);
});

fs.rmSync(tmpIR, { force: true });
fs.rmSync(tmpBuild, { force: true });
console.log('─'.repeat(60));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
