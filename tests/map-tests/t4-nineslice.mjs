// t4-nineslice.mjs — 九宫格 capInsets→border; Sprite.type simple/sliced→imageType
// 引擎实证(cocos-engine v3.8.8 cocos/2d/assets/sprite-frame.ts):
//   _capInsets 不是 Rect 而是数组 [INSET_LEFT=0, INSET_TOP=1, INSET_RIGHT=2, INSET_BOTTOM=3]
//   → Unity border(BUILD-SCHEMA 定义 [L,B,R,T]) = [c[0], c[3], c[2], c[1]]; 全 0 → null。
// 旁证: battle zd_zk_line_sj(22×18 横线) capInsets [11,0,8,0] → 上下 inset 为 0,
//       正是"只横向拉伸的横线", 与数组直存语义吻合(Rect 解读则会出现 18px 假下边)。
import { loadBuild, findNode, sprite, deepEqual } from './lib.mjs';
import assert from 'node:assert/strict';

const guide = loadBuild('demo-pfb_demo_guide');
const home = loadBuild('demo-demo_rank_reward');

// border 直存换序
deepEqual(sprite(guide, 'sprite_nine').border, [30, 30, 30, 30], 'sprite_nine capInsets[30,30,30,30] → [L,B,R,T]=[30,30,30,30]');
deepEqual(sprite(home, 'sprite_card_sl').border, [22, 8, 17, 7], 'sprite_card_sl capInsets[22,7,17,8]=[L,T,R,B] → [L,B,R,T]=[22,8,17,7]');
deepEqual(sprite(home, 'rank_di_green').border, [21, 0, 21, 0], 'rank_di_green [21,0,21,0] → 横向拉伸条');
deepEqual(sprite(guide, 'sprite_bg').border, null, 'sprite_bg capInsets 全 0 → border null(非九宫格)');
deepEqual(sprite(home, 'sprite_card_di').border, [14, 16, 14, 16], 'sprite_card_di [14,16,14,16]');
deepEqual(sprite(home, 'rank_di_black_01').border, [15, 15, 15, 15], 'rank_di_black_01 [15,15,15,15]');

// Sprite._type: 0=simple(缺省) 1=sliced
{
  const img = findNode(guide.root, '_nd:dialog', '_nd:bg').components.find(c => c.type === 'Image');
  assert.equal(img.props.sprite, 'sprite_nine');
  assert.equal(img.props.imageType, 'Sliced', '_type 1 → Sliced');
}
{
  const img = findNode(guide.root, '_nd:dialog', '_spr:speaker').components.find(c => c.type === 'Image');
  assert.equal(img.props.imageType, 'Simple', '_type 缺省(0) → Simple');
}
{
  const img = findNode(home.root, '_nd:rank_name').components.find(c => c.type === 'Image');
  assert.equal(img.props.imageType, 'Simple', 'jjc_top_yellow 无 _type → Simple');
}
{
  const img = findNode(home.root, '_scroll:content', 'view', '_nd:content').components.find(c => c.type === 'Image');
  assert.equal(img.props.imageType, 'Sliced', '_nd:content 九宫格背景 Sliced');
}
// rect 透传(切图矩形按 Cocos 坐标系 y 自顶向下原样输出, 由 P4 处理)
deepEqual(sprite(guide, 'sprite_icon_sz').rect, { x: 1, y: 0, w: 121, h: 124 }, 'sprite_icon_sz rect 透传');
deepEqual(sprite(home, 'arena_gx').rect, { x: 0, y: 25, w: 717, h: 789 }, 'arena_gx rect 透传(非零 y 偏移)');
console.log('t4-nineslice: 11 例通过');
