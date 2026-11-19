// t6-rotated.mjs — rotated=true 切图处理策略
// 策略(rules.md §8): sprites[] 原样透传 rect(Cocos 坐标 y 自顶向下) + rotated:true,
// w/h 不交换; P4 在 Unity 侧从图集裁剪时逆旋转 90° 落到独立 Sprite(Unity Sprite
// 无法表达图集内旋转)。这里锁定: build 数据不因 rotated 而篡改 rect。
import { loadBuild, sprite, deepEqual } from './lib.mjs';
import assert from 'node:assert/strict';

const battle = loadBuild('demo-ui-demo_statistic_view');

const rotatedSprites = [
  ['main_graph_small_01', { x: 714, y: 882, w: 126, h: 30 }],
  ['zd_zk_line_sj', { x: 568, y: 359, w: 22, h: 18 }],
  ['zd_light', { x: 246, y: 1758, w: 153, h: 137 }],
  ['zd_icon_vs', { x: 633, y: 1630, w: 110, h: 64 }],
  ['zd_sl_icon__ls', { x: 319, y: 1512, w: 66, h: 72 }],
];
for (const [name, rect] of rotatedSprites) {
  const s = sprite(battle, name);
  assert.ok(s, `sprite ${name} 存在`);
  assert.equal(s.rotated, true, `${name} rotated=true 透传`);
  deepEqual(s.rect, rect, `${name} rect 原样(未交换 w/h)`);
}
// 未旋转的切图保持 rotated:false
assert.equal(sprite(battle, 'common_pop_bg_00').rotated, false);
assert.equal(sprite(battle, 'zd_zk_bg_01').rotated, false);
// 引用 rotated 切图的 Image 正常引用(引用侧无旋转概念)
// 实测: zd_graph_red×2 + zd_graph_blue×2 = 4 个节点共用同一 rotated 切图(sprites[] 去重后 1 条)
const imgs = [];
(function walk(n, parent) { for (const c of n.components || []) if (c.type === 'Image' && c.props.sprite === 'main_graph_small_01') imgs.push(parent + '/' + n.name); n.children?.forEach(c => walk(c, parent + '/' + n.name)); })(battle.root, '');
assert.equal(imgs.length, 4, '4 个 main_graph_small 节点(red×2+blue×2)引用同一 rotated 切图');
assert.equal(imgs.filter(p => p.includes('zd_graph_red')).length, 2, 'red 侧 2 个');
assert.equal(imgs.filter(p => p.includes('zd_graph_blue')).length, 2, 'blue 侧 2 个');
assert.equal(battle.sprites.filter(s => s.name === 'main_graph_small_01').length, 1, 'sprites[] 去重');
console.log('t6-rotated: 8 例通过');
