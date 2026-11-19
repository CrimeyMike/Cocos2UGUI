// t2-pivot-sizedelta.mjs — _anchorPoint→pivot, _contentSize→sizeDelta
// 推导: pivot 直拷 UITransform._anchorPoint(两引擎锚点语义一致, 归一化分数, Y 同向上);
//       sizeDelta 在无 Widget 拉伸的轴上 == _contentSize 对应分量。
import { loadBuild, findNode, deepEqual } from './lib.mjs';

const guide = loadBuild('demo-pfb_demo_guide');
const home = loadBuild('demo-demo_rank_reward');
const battle = loadBuild('demo-ui-demo_statistic_view');

// guide _spr:speaker: _anchorPoint (0.5, 0) → pivot [0.5, 0]; _contentSize 257×239 → sizeDelta
{
  const n = findNode(guide.root, '_nd:dialog', '_spr:speaker');
  deepEqual(n.rect.pivot, [0.5, 0], 'speaker pivot');
  deepEqual(n.rect.sizeDelta, [257, 239], 'speaker sizeDelta');
}
// guide _nd:finger: 无 _anchorPoint(默认 .5,.5) 无 _contentSize 之外的信息: size 122×125
{
  const n = findNode(guide.root, '_nd:finger');
  deepEqual(n.rect.pivot, [0.5, 0.5], 'finger pivot 默认值');
  deepEqual(n.rect.sizeDelta, [122, 125], 'finger sizeDelta');
}
// home _spr:city: _anchorPoint (0.5,0), 626×525
{
  const n = findNode(home.root, '_nd:city', '_spr:city');
  deepEqual(n.rect.pivot, [0.5, 0], '_spr:city pivot');
  deepEqual(n.rect.sizeDelta, [626, 525], '_spr:city sizeDelta');
}
// home _scroll:content: _anchorPoint (0.5,1) → pivot [0.5,1]
{
  const n = findNode(home.root, '_scroll:content');
  deepEqual(n.rect.pivot, [0.5, 1], '_scroll:content pivot');
}
// home vlist_unlockCard: _anchorPoint (0,0.5) → pivot [0,0.5]; size 497.909×250
{
  const n = findNode(home.root, '_scroll:content', 'view', '_nd:content', '_nd:card_unlock', 'vlist_unlockCard');
  deepEqual(n.rect.pivot, [0, 0.5], 'vlist pivot');
  near(n.rect.sizeDelta[0], 497.909, 'vlist sizeDelta.w');
  deepEqual([n.rect.sizeDelta[1]], [250], 'vlist sizeDelta.h');
}
// battle _lab:red_name: _anchorPoint (0,0.5); battle item_card spine 节点小数锚点保 4 位
{
  const n = findNode(battle.root, 'zd_graph_red', '_lab:red_name');
  deepEqual(n.rect.pivot, [0, 0.5], '_lab:red_name pivot');
}
{
  const n = findNode(battle.root, 'zd_graph_red', '_nd:red_card_layer', 'item_card', '_spine:orange_spine_1');
  deepEqual(n.rect.pivot, [0.5432, 0.0012], 'spine pivot 四舍五入到 4 位');
  near(n.rect.sizeDelta[0], 119.8738, 'spine sizeDelta.w');
  near(n.rect.sizeDelta[1], 154.677, 'spine sizeDelta.h');
}
function near(a, b, msg, eps = 1e-3) {
  if (Math.abs(a - b) > eps) throw new Error(`${msg}: ${a} != ${b}`);
}
console.log('t2-pivot-sizedelta: 7 例通过');
