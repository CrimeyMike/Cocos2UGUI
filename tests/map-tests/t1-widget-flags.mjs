// t1-widget-flags.mjs — Widget._alignFlags 位组合 → anchorMin/Max + offsetMin/Max
// 期望值全部手工推导(推导写在各断言前), 引用规则见 ../rules.md §2/§4。
// 位定义(引擎 widget-component.ts): TOP=1 MID=2 BOT=4 LEFT=8 CENTER=16 RIGHT=32
import { loadBuild, findNode, near, deepEqual } from './lib.mjs';
import assert from 'node:assert/strict';

const home = loadBuild('demo-demo_rank_reward');
const guide = loadBuild('demo-pfb_demo_guide');

// ── 例 1: 四边拉伸 (flags 45 = LEFT|RIGHT|TOP|BOT, 边距全 0) ────────────────
// guide 根节点。x: L&&R → anchors [0,1], offset [_left=0, -_right=0]
//                      y: T&&B → anchors [0,1], offset [_bottom=0, -_top=0]
// sizeDelta = offsetMax-offsetMin = [0,0]; 实际运行尺寸 = sizeDelta + (1-0)*父尺寸
//           = 750×1334 == designResolution(自洽)。anchoredPosition = 0+pivot*0 = 0。
{
  const n = guide.root;
  deepEqual(n.rect.anchorMin, [0, 0], 'root anchorMin');
  deepEqual(n.rect.anchorMax, [1, 1], 'root anchorMax');
  deepEqual(n.rect.offsetMin, [0, 0], 'root offsetMin');
  deepEqual(n.rect.offsetMax, [0, 0], 'root offsetMax');
  deepEqual(n.rect.sizeDelta, [0, 0], 'root sizeDelta');
  deepEqual(n.rect.anchoredPosition, [0, 0], 'root anchoredPosition');
}

// ── 例 2: 仅贴顶 + 负 top 边距 (flags 1, _top=-180) ────────────────────────
// home/bg: size 750×1700, anchor(.5,.5), 父 root 750×1334 anchor(.5,.5)。
// y: TOP → anchors [1,1]; hi = -_top = +180 (top 边距为负=越出父顶 → offsetMax.y 为正)
//    lo = 180 - 1700 = -1520; sizeDelta.y = 1700; ap.y = -1520+0.5*1700 = -670。
// x: 无 flag → 锚点=父锚点 0.5; lo = 0-0.5*750 = -375, hi = 375。
// 验证: Cocos 序列化 pos y=-3(中心), 父顶在中心上方 667 → ap = -3-667 = -670 ✓
{
  const n = findNode(home.root, 'bg');
  deepEqual(n.rect.anchorMin, [0.5, 1], 'bg anchorMin');
  deepEqual(n.rect.anchorMax, [0.5, 1], 'bg anchorMax');
  deepEqual(n.rect.offsetMin, [-375, -1520], 'bg offsetMin');
  deepEqual(n.rect.offsetMax, [375, 180], 'bg offsetMax');
  deepEqual(n.rect.sizeDelta, [750, 1700], 'bg sizeDelta');
  deepEqual(n.rect.anchoredPosition, [0, -670], 'bg anchoredPosition');
}

// ── 例 3: 仅贴顶 + 正 top 边距, UITransform 空属性(默认 100×100/锚点.5) ────
// home/_nd:city: flags 1, _top=287.913。y: hi=-287.913, lo=-387.913,
// sizeDelta.y=100, ap.y=-337.913。
// 验证: 序列化 pos y=329.087; 顶边=667-287.913=379.087, 中心=379.087-50=329.087 ✓
{
  const n = findNode(home.root, '_nd:city');
  deepEqual(n.rect.anchorMin, [0.5, 1], '_nd:city anchorMin');
  deepEqual(n.rect.offsetMin, [-50, -387.913], '_nd:city offsetMin');
  deepEqual(n.rect.offsetMax, [50, -287.913], '_nd:city offsetMax');
  deepEqual(n.rect.sizeDelta, [100, 100], '_nd:city sizeDelta');
  deepEqual(n.rect.anchoredPosition, [0, -337.913], '_nd:city anchoredPosition');
}

// ── 例 4: 横向拉伸+贴顶, 百分比边距 (flags 41 = TOP|LEFT|RIGHT, _isAbsTop=false)
// home/_scroll:content/view: size 520×688, anchor(.5,1), 父 520×581.047。
// x: L&&R 边距 0 → anchors [0,1], offset [0,0], sizeDelta.x=0
//    → 实际宽 = 0+(1-0)*520 = 520 == 序列化 contentSize.width ✓(父宽变化自动跟随)
// y: TOP, _top 缺省 0 且百分比制 → 0%*581.047 = 0 → hi=0, lo=-688, sizeDelta.y=688
// ap = (0+0.5*0, -688+1*688) = (0,0) == 序列化 _lpos(缺省 0,0) ✓
{
  const n = findNode(home.root, '_scroll:content', 'view');
  deepEqual(n.rect.anchorMin, [0, 1], 'view anchorMin');
  deepEqual(n.rect.anchorMax, [1, 1], 'view anchorMax');
  deepEqual(n.rect.offsetMin, [0, -688], 'view offsetMin');
  deepEqual(n.rect.offsetMax, [0, 0], 'view offsetMax');
  deepEqual(n.rect.sizeDelta, [0, 688], 'view sizeDelta');
  deepEqual(n.rect.anchoredPosition, [0, 0], 'view anchoredPosition');
  deepEqual(n.rect.pivot, [0.5, 1], 'view pivot');
}

// ── 例 5: 纵向拉伸 (flags 5 = TOP|BOT, 边距 0), x 用 lpos ─────────────────
// home/_btn:close: size 750×1334, lpos x=-5.302, 父 root。
// y: anchors [0,1], offset [0,0], sizeDelta.y=0 → 实际高 = 1334 == 序列化 ✓
// x: 锚点=父锚点 0.5; lo=-5.302-375=-380.302, hi=369.698; ap.x=-5.302 == lpos.x ✓
{
  const n = findNode(home.root, '_btn:close');
  deepEqual(n.rect.anchorMin, [0.5, 0], '_btn:close anchorMin');
  deepEqual(n.rect.anchorMax, [0.5, 1], '_btn:close anchorMax');
  deepEqual(n.rect.offsetMin, [-380.302, 0], '_btn:close offsetMin');
  deepEqual(n.rect.offsetMax, [369.698, 0], '_btn:close offsetMax');
  deepEqual(n.rect.sizeDelta, [750, 0], '_btn:close sizeDelta');
  deepEqual(n.rect.anchoredPosition, [-5.302, 0], '_btn:close anchoredPosition');
}

// ── 例 6: 纵向拉伸 + 父锚点非中心 (同 flags 5) ─────────────────────────────
// home .../vlist_unlockCard/content: 父 vlist_unlockCard anchor(0,0.5) size 497.909×250。
// x: 锚点=父锚点 0 → lo=0-0*100=0, hi=100, sizeDelta.x=100; ap.x=0
// y: anchors [0,1], offset [0,0], sizeDelta.y=0 → 实际高=250 == 序列化 height ✓
{
  const n = findNode(home.root, '_scroll:content', 'view', '_nd:content', '_nd:card_unlock', 'vlist_unlockCard', 'content');
  deepEqual(n.rect.anchorMin, [0, 0], 'content anchorMin');
  deepEqual(n.rect.anchorMax, [0, 1], 'content anchorMax');
  deepEqual(n.rect.offsetMin, [0, 0], 'content offsetMin');
  deepEqual(n.rect.offsetMax, [100, 0], 'content offsetMax');
  deepEqual(n.rect.sizeDelta, [100, 0], 'content sizeDelta');
  deepEqual(n.rect.pivot, [0, 0.5], 'content pivot');
  deepEqual(n.rect.anchoredPosition, [0, 0], 'content anchoredPosition');
}

// ── 例 7: 贴顶 + 自定义锚点(.5,1) (flags 1, _top=623.989) ──────────────────
// home/_scroll:content: size 520×581.047, anchor(.5,1)。
// y: hi=-623.989, lo=-623.989-581.047=-1205.036; ap.y = -1205.036+1*581.047 = -623.989
// 验证: 序列化 pos y=43.011, 顶边=43.011(anchor 顶), 667-43.011=623.989 ✓
// 注: 该 Widget 序列化了 _bottom=79.891, 但 BOT 位未置 → 不参与布局(inert), 见 rules.md。
{
  const n = findNode(home.root, '_scroll:content');
  deepEqual(n.rect.offsetMin, [-260, -1205.036], '_scroll:content offsetMin');
  deepEqual(n.rect.offsetMax, [260, -623.989], '_scroll:content offsetMax');
  deepEqual(n.rect.sizeDelta, [520, 581.047], '_scroll:content sizeDelta');
  deepEqual(n.rect.pivot, [0.5, 1], '_scroll:content pivot');
  deepEqual(n.rect.anchoredPosition, [0, -623.989], '_scroll:content anchoredPosition');
}

// ── 例 8: 贴顶 (flags 1, _top=553.322), 默认锚点 ──────────────────────────
// home/_nd:rank_name: size 450×86。hi=-553.322, lo=-639.322, ap.y=-596.322。
// 验证: 序列化 pos y=70.678 → 顶边=70.678+43=113.678, 667-113.678=553.322 ✓
{
  const n = findNode(home.root, '_nd:rank_name');
  deepEqual(n.rect.anchorMin, [0.5, 1], '_nd:rank_name anchorMin');
  deepEqual(n.rect.offsetMin, [-225, -639.322], '_nd:rank_name offsetMin');
  deepEqual(n.rect.offsetMax, [225, -553.322], '_nd:rank_name offsetMax');
  deepEqual(n.rect.sizeDelta, [450, 86], '_nd:rank_name sizeDelta');
  deepEqual(n.rect.anchoredPosition, [0, -596.322], '_nd:rank_name anchoredPosition');
}

// H_CENTER/V_CENTER(位 16/2)样例语料未出现 → 由 t9-synthetic.mjs 用构造 IR 覆盖。
console.log('t1-widget-flags: 8 例通过');
