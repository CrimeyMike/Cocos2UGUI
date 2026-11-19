// t3-lpos.mjs — _lpos → anchoredPosition (含父锚点≠中心、父尺寸变化)
// 推导: 无 Widget 轴的锚点取"父锚点"(parentAnchor), 此时 UGUI 锚点参考点恰与 Cocos
// 父节点锚点重合 → anchoredPosition = _lpos 逐分量直拷(两坐标系均 X 右 Y 上)。
// offsetMin = lpos - anchorPoint*size; offsetMax = offsetMin + sizeDelta。
import { loadBuild, findNode, near } from './lib.mjs';
import assert from 'node:assert/strict';

const guide = loadBuild('demo-pfb_demo_guide');
const home = loadBuild('demo-demo_rank_reward');
const battle = loadBuild('demo-ui-demo_statistic_view');

// 例 1: 父锚点为中心 (guide nameBg, 父 _nd:dialog anchor (.5,.5) size 默认 100×100)
// lpos (-236.023, 110.806), 自身 anchor(.5,.5) size 120×40:
//   offsetMin = (-236.023-60, 110.806-20) = (-296.023, 90.806)
//   offsetMax = (-176.023, 130.806); anchoredPosition == lpos 原值
{
  const n = findNode(guide.root, '_nd:dialog', 'nameBg');
  near(n.rect.anchoredPosition, [-236.023, 110.806], 'nameBg anchoredPosition == lpos');
  near(n.rect.offsetMin, [-296.023, 90.806], 'nameBg offsetMin');
  near(n.rect.offsetMax, [-176.023, 130.806], 'nameBg offsetMax');
}

// 例 2: 父锚点非中心 (battle item_card, 父 _nd:red_card_layer anchor (0,0.5) size 86.24×100)
// lpos (43.12, -2.448), anchor(.5,.5) size 154×224:
//   子锚点 = 父锚点 [0, 0.5]; anchoredPosition == (43.12, -2.448)
//   offsetMin = (43.12-77, -2.448-112) = (-33.88, -114.448)   [相对父左锚点参考系]
//   offsetMax = (120.12, 109.552)
{
  const n = findNode(battle.root, 'zd_graph_red', '_nd:red_card_layer', 'item_card');
  near(n.rect.anchoredPosition, [43.12, -2.448], 'item_card anchoredPosition == lpos');
  near(n.rect.anchorMin, [0, 0.5], 'item_card 锚点=父锚点');
  near(n.rect.offsetMin, [-33.88, -114.448], 'item_card offsetMin');
  near(n.rect.offsetMax, [120.12, 109.552], 'item_card offsetMax');
}

// 例 3: 自身 pivot 非中心 (battle _lab:red_name anchor(0,0.5) size 109.096×43.8, lpos (-183.285,119.652))
//   offsetMin = (-183.285 - 0*109.096, 119.652 - 0.5*43.8) = (-183.285, 97.752)
//   offsetMax = (-74.189, 141.552); anchoredPosition == lpos
{
  const n = findNode(battle.root, 'zd_graph_red', '_lab:red_name');
  near(n.rect.anchoredPosition, [-183.285, 119.652], '_lab:red_name ap == lpos');
  near(n.rect.offsetMin, [-183.285, 97.752], '_lab:red_name offsetMin');
  near(n.rect.offsetMax, [-74.189, 141.552], '_lab:red_name offsetMax');
}

// 例 4: 父尺寸变化的情况 —— Widget 拉伸轴上 sizeDelta=0, 实际尺寸=父尺寸(改父即改子):
// home view (flags 41 横向拉伸): sizeDelta.x=0, 实际宽 = 0 + (1-0)*父宽520 = 520
//         == 序列化 _contentSize.width 520 (自洽: 父尺寸变化时子跟随, 等价 UGUI stretch)
// home _btn:close (flags 5 纵向拉伸): sizeDelta.y=0, 实际高 = 父高 1334 == 序列化 1334
{
  const view = findNode(home.root, '_scroll:content', 'view');
  assert.equal(view.rect.sizeDelta[0], 0, 'view sizeDelta.x (stretch)');
  const actualW = view.rect.sizeDelta[0] + (view.rect.anchorMax[0] - view.rect.anchorMin[0]) * 520;
  near(actualW, 520, 'view 实际宽 = 父宽');

  const btn = findNode(home.root, '_btn:close');
  assert.equal(btn.rect.sizeDelta[1], 0, 'close sizeDelta.y (stretch)');
  const actualH = btn.rect.sizeDelta[1] + (btn.rect.anchorMax[1] - btn.rect.anchorMin[1]) * 1334;
  near(actualH, 1334, 'close 实际高 = 父高');
}

// 例 5: 嵌套 prefab 展开后的节点 (home item_card, 父 vlist content anchor(0,0.5)):
// lpos (247.725, 0), size 154×224 → anchoredPosition == lpos, 锚点=父锚点[0,0.5]
{
  const n = findNode(home.root, '_scroll:content', 'view', '_nd:content', '_nd:card_unlock', 'vlist_unlockCard', 'content', 'item_card');
  near(n.rect.anchoredPosition, [247.725, 0], 'home item_card ap == lpos');
  near(n.rect.anchorMin, [0, 0.5], 'home item_card 锚点=父锚点');
}

// 例 6: guide _lab:dialog lpos y=-8.674(浮点噪声 999978) → 4 位舍入 -8.674
{
  const n = findNode(guide.root, '_nd:dialog', '_lab:dialog');
  near(n.rect.anchoredPosition, [0, -8.674], '_lab:dialog ap 舍入');
  near(n.rect.sizeDelta, [620, 79.1], '_lab:dialog sizeDelta');
}
console.log('t3-lpos: 6 例通过');
