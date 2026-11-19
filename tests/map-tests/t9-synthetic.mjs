// t9-synthetic.mjs — 构造 IR 覆盖语料中未出现的 Widget 位与属性
// (H_CENTER=16 / V_CENTER=MID=2 / TOP_LEFT=9 / BOTTOM_RIGHT=36 / 百分比边距 /
//  UIOpacity 非默认值 / 旋转缩放)。期望值全部手算。
// 注意: 该 IR 为手工构造(三样例中无这些组合), 公式与实测量纲一致, 见 rules.md §4。
import fs from 'node:fs';
import path from 'node:path';
import { DIR } from './lib.mjs';
import assert from 'node:assert/strict';

const syn = JSON.parse(fs.readFileSync(path.join(DIR, '.tmp-synthetic.build.json'), 'utf8'));
function find(name) {
  let r = null;
  (function w(n) { if (n.name === name) r = n; n.children?.forEach(w); })(syn.root);
  if (!r) throw new Error('节点不存在: ' + name);
  return r;
}
const eq = (a, e, m) => assert.deepEqual(a, e, m);

// ── H_CENTER(16): 节点中心对齐父中心 ──────────────────────────────────────
// nd_center_h: 父 root anchor(.5,.5) 750×1334; 节点 200×60 anchor(.5,.5), lpos(37,50)。
// x: 虚拟 lpos.x = 750*(0.5-0.5) = 0 → lo=-100, hi=100, sizeDelta 200, ap.x=0 (37 被覆盖)
// y: 无 flag → ap.y = lpos.y = 50; lo=50-30=20, hi=80
{
  const r = find('nd_center_h').rect;
  eq(r.anchorMin, [0.5, 0.5], 'center_h anchorMin');
  eq(r.offsetMin, [-100, 20], 'center_h offsetMin');
  eq(r.offsetMax, [100, 80], 'center_h offsetMax');
  eq(r.sizeDelta, [200, 60], 'center_h sizeDelta');
  eq(r.anchoredPosition, [0, 50], 'center_h ap (x 被 CENTER 覆盖为 0, y 保留 lpos)');
}
// ── V_CENTER/MID(2) ───────────────────────────────────────────────────────
// nd_center_v: y 虚拟 lpos.y = 1334*(0.5-0.5)=0 → lo=-30, hi=30, ap.y=0;
//              x 保留 lpos.x=37 → lo=-63, hi=137
{
  const r = find('nd_center_v').rect;
  eq(r.anchoredPosition, [37, 0], 'center_v ap (y 被 MID 覆盖, x 保留)');
  eq(r.offsetMin, [-63, -30], 'center_v offsetMin');
  eq(r.offsetMax, [137, 30], 'center_v offsetMax');
}
// ── 父锚点非中心时的 CENTER: 父 anchor.x=0 → 父中心在父锚点右侧 400*(0.5-0)=200 ──
// nd_child_centerH: 50×50 → lo=200-25=175, hi=225, 锚点 x=[0,0], ap.x=200
{
  const r = find('nd_child_centerH').rect;
  eq(r.anchorMin.slice(0, 1), [0], 'child_centerH 锚点=父锚点 0');
  eq(r.offsetMin.slice(0, 1), [175], 'child_centerH offsetMin.x');
  eq(r.offsetMax.slice(0, 1), [225], 'child_centerH offsetMax.x');
  eq(r.anchoredPosition.slice(0, 1), [200], 'child_centerH ap.x = 父中心相对父锚点偏移');
}
// ── TOP_LEFT(9) 绝对边距 ──────────────────────────────────────────────────
// nd_topleft: _left 20 _top 10, 100×50:
// x: anchors[0,0], off[20,120]; y: anchors[1,1], off[-60,-10]; ap=(20+50, -60+25)=(70,-35)
{
  const r = find('nd_topleft').rect;
  eq(r.anchorMin, [0, 1], 'topleft anchorMin [LEFT=0, TOP=1]');
  eq(r.anchorMax, [0, 1], 'topleft anchorMax');
  eq(r.offsetMin, [20, -60], 'topleft offsetMin');
  eq(r.offsetMax, [120, -10], 'topleft offsetMax');
  eq(r.anchoredPosition, [70, -35], 'topleft ap');
}
// ── BOTTOM_RIGHT(36) 绝对边距 ─────────────────────────────────────────────
// nd_bottom_right: _bottom 30 _right 40, 100×50:
// x: anchors[1,1], lo=-140, hi=-40; y: anchors[0,0], lo=30, hi=80; ap=(-90, 55)
{
  const r = find('nd_bottom_right').rect;
  eq(r.anchorMin, [1, 0], 'bottomright anchorMin [RIGHT=1, BOT=0]');
  eq(r.offsetMin, [-140, 30], 'bottomright offsetMin');
  eq(r.offsetMax, [-40, 80], 'bottomright offsetMax');
  eq(r.anchoredPosition, [-90, 55], 'bottomright ap');
}
// ── 百分比边距: _isAbsTop=false, _top=0.25 → 0.25*1334 = 333.5 ────────────
// nd_pct_top: 80×60: hi=-333.5, lo=-393.5, sizeDelta.y=60
{
  const r = find('nd_pct_top').rect;
  eq(r.offsetMax.slice(1), [-333.5], 'pct offsetMax.y = -0.25*1334');
  eq(r.offsetMin.slice(1), [-393.5], 'pct offsetMin.y');
  eq(r.sizeDelta.slice(1), [60], 'pct sizeDelta.y 不受百分比影响');
}
// ── UIOpacity 128 → alpha 128/255 = 0.502 ─────────────────────────────────
{
  const comps = find('nd_opacity').components;
  const cg = comps.find(c => c.type === 'CanvasGroup');
  assert.ok(cg, 'opacity → CanvasGroup');
  assert.ok(Math.abs(cg.props.alpha - 0.502) < 1e-3, `alpha ${cg.props.alpha} == 0.502`);
}
// ── 旋转(45° 四元数)与缩放 ────────────────────────────────────────────────
{
  const r = find('nd_rot_scale').rect;
  assert.ok(Math.abs(r.rotationZ - 45) < 1e-3, `rotationZ ${r.rotationZ} == 45`);
  eq(r.scale, [2, 0.5, 1], 'scale [sx,sy,1]');
}
console.log('t9-synthetic: 全部通过');
