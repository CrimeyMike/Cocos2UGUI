// t7-signs.mjs — Y 轴 / offset 符号实证
// 结论(rules.md §5): 两引擎 rect 空间均 X 右 Y 上, 数值同号;
//   但 Cocos _top/_right 是"到父上/右边的距离"(正值=内缩), UGUI offsetMax 是
//   "矩形上/右 edge 超出锚点参考的偏移"(正值=外扩) → 取负:
//     offsetMin = (+_left, +_bottom)   符号不变
//     offsetMax = (-_right, -_top)     符号翻转
// 实证 A(负 top → 正 offsetMax.y): home bg _top=-180, 顶边越出父顶 180px:
//   Cocos: 顶边 = 667+180 = 847 (节点 pos y=-3, h=1700, anchor .5: -3+850=847 ✓)
//   UGUI: offsetMax.y = -(-180) = +180 (锚点=父顶, 正=向上超出) ✓
// 实证 B(正 top → 负 offsetMax.y): home _nd:city _top=287.913:
//   顶边 = 667-287.913 = 379.087 (pos 329.087+50 ✓); offsetMax.y = -287.913 ✓
import { loadBuild, findNode, deepEqual } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DIR } from './lib.mjs';

const home = loadBuild('demo-demo_rank_reward');

// A. _top = -180 → offsetMax.y = +180 (重点: 正数!)
deepEqual(findNode(home.root, 'bg').rect.offsetMax.slice(1), [180], 'bg offsetMax.y=+180');
// B. _top = +287.913 → offsetMax.y = -287.913
deepEqual(findNode(home.root, '_nd:city').rect.offsetMax.slice(1), [-287.913], '_nd:city offsetMax.y=-287.913');
// C. _left/_bottom 正边距 → offsetMin 正号不变; _right → offsetMax.x 负号 (合成样例)
//    nd_topleft: _left 20 _top 10 → offsetMin.x=+20, offsetMax.y=-10
//    nd_bottom_right: _bottom 30 _right 40 → offsetMin.y=+30, offsetMax.x=-40
{
  const syn = JSON.parse(fs.readFileSync(path.join(DIR, '.tmp-synthetic.build.json'), 'utf8'));
  const tl = (function find(n, name) { if (n.name === name) return n; for (const c of n.children || []) { const r = find(c, name); if (r) return r; } })(syn.root, 'nd_topleft');
  deepEqual(tl.rect.offsetMin.slice(0, 1), [20], '_left 20 → offsetMin.x=+20');
  deepEqual(tl.rect.offsetMax.slice(1), [-10], '_top 10 → offsetMax.y=-10');
  const br = (function find(n, name) { if (n.name === name) return n; for (const c of n.children || []) { const r = find(c, name); if (r) return r; } })(syn.root, 'nd_bottom_right');
  deepEqual(br.rect.offsetMin.slice(1), [30], '_bottom 30 → offsetMin.y=+30');
  deepEqual(br.rect.offsetMax.slice(0, 1), [-40], '_right 40 → offsetMax.x=-40');
}
// D. 符号总表自洽(往返复算): bg anchors y=[1,1] → 两锚点均=父顶(父中心上方 667)。
// Cocos 序列化自证: 顶边 = pos.y(-3) + (1-anchorY=.5)*1700 = -3+850 = 847
//                   底边 = 847 - 1700 = -853
// UGUI 复算: 顶边 = 667 + offsetMax.y(180) = 847 ✓
//            底边 = 667 + offsetMin.y(-1520) = -853 ✓  (负号方向与 Cocos 完全一致)
{
  const r = findNode(home.root, 'bg').rect;
  const topEdge = 1334 / 2 + r.offsetMax[1];
  const bottomEdge = 1334 / 2 + r.offsetMin[1];
  assert.ok(Math.abs(topEdge - 847) < 1e-6, `顶边复算 ${topEdge} == 847 (Cocos -3+850)`);
  assert.ok(Math.abs(bottomEdge - (-853)) < 1e-6, `底边复算 ${bottomEdge} == -853 (847-1700)`);
}
console.log('t7-signs: 4 组通过');
