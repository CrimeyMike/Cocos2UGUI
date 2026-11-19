// t5-label-layout-opacity.mjs — Label 枚举映射 / UIOpacity→CanvasGroup / Layout→LayoutGroup
import { loadBuild, findNode, comp, near, deepEqual } from './lib.mjs';
import assert from 'node:assert/strict';

const guide = loadBuild('demo-pfb_demo_guide');
const home = loadBuild('demo-demo_rank_reward');
const battle = loadBuild('demo-ui-demo_statistic_view');

// ── Label: 对齐/溢出/行高/颜色 ─────────────────────────────────────────────
// guide _lab:dialog: _horizontalAlign 0(左), _verticalAlign 缺省 0(顶) → UpperLeft
//   _overflow 3 = RESIZE_HEIGHT → "ResizeHeight"; _lineHeight 35 / _fontSize 28 = 1.25
//   _color (255,157,89,51) → [1, 0.6157, 0.349, 0.2]
{
  const t = comp(findNode(guide.root, '_nd:dialog', '_lab:dialog'), 'Text').props;
  assert.equal(t.alignment, 'UpperLeft');
  assert.equal(t.overflow, 'ResizeHeight');
  near(t.lineSpacing, 1.25, 'lineSpacing = 35/28');
  near(t.color, [1, 0.6157, 0.349, 0.2], 'color rgba/255');
  assert.equal(t.fontSize, 28);
  assert.equal(t.richText, false, 'cc.Label 无富文本');
  assert.equal(t.text, '这是一段新手引导对话，这是一段新手引导对话，这是一段新手引导对话');
}
// guide label(精锐特工): _horizontalAlign/_overflow 均缺省 → UpperLeft + Overflow; 26/26 = 1
{
  const t = comp(findNode(guide.root, '_nd:dialog', 'label'), 'Text').props;
  assert.equal(t.alignment, 'UpperLeft', '缺省水平对齐=LEFT');
  assert.equal(t.overflow, 'Overflow', '缺省 _overflow=NONE → Overflow');
  near(t.lineSpacing, 1, '26/26');
}
// battle _lab:red_name: _lineHeight 30 / 28 = 1.0714; _color (255,111,111,255)
{
  const t = comp(findNode(battle.root, 'zd_graph_red', '_lab:red_name'), 'Text').props;
  near(t.lineSpacing, 1.0714, '30/28');
  near(t.color, [1, 0.4353, 0.4353, 1], 'rgba');
}
// battle _lab:red_trophy: 23/20 = 1.15
{
  const t = comp(findNode(battle.root, 'zd_graph_red', '_lab:red_trophy'), 'Text').props;
  near(t.lineSpacing, 1.15, '23/20');
}
// home _lab:lock: _overflow 2 = SHRINK → "Shrink"
{
  const t = comp(findNode(home.root, '_scroll:content', 'view', '_nd:content', '_nd:card_unlock', 'vlist_unlockCard', 'content', 'item_card', '_lab:lock'), 'Text').props;
  assert.equal(t.overflow, 'Shrink', '_overflow 2 → Shrink');
}
// 描边 → 无 UGUI 等价, 必须进 unmapped(禁止静默丢)
assert.ok(guide.unmapped.some(u => u.component === 'cc.Label.outline'),
  'guide label 描边记录到 unmapped');
// 位图字体: 每面板聚合一条 unmapped
assert.ok(guide.unmapped.some(u => u.component === 'cc.Label._font' && u.reason.includes('font/font1')),
  'guide 位图字体聚合记录');

// ── UIOpacity → CanvasGroup ────────────────────────────────────────────────
// guide 根 UIOpacity props 空(默认 255) → alpha 1
{
  const cg = comp(guide.root, 'CanvasGroup');
  assert.ok(cg, 'root 有 CanvasGroup');
  assert.equal(cg.props.alpha, 1, '默认不透明度 255 → 1');
  assert.equal(cg.props.blocksRaycasts, true);
}
// battle common_pop_bg_00 UIOpacity props 空 → 1; 非默认值见 t9 合成样例(128→0.502)
{
  const cg = comp(findNode(battle.root, 'common_pop_bg_00'), 'CanvasGroup');
  assert.equal(cg.props.alpha, 1);
}

// ── Layout → LayoutGroup ──────────────────────────────────────────────────
// home _nd:func_unlock: _layoutType 2(垂直) _spacingY 20 _paddingBottom 20 _resizeMode 1
//   → Vertical / spacing 20 / padding [L,B,R,T]=[0,20,0,0] / Container / UpperLeft(默认 T2B+L2R)
{
  const l = comp(findNode(home.root, '_scroll:content', 'view', '_nd:content', '_nd:func_unlock'), 'Layout').props;
  assert.equal(l.layoutType, 'Vertical');
  assert.equal(l.spacing, 20, '_spacingY');
  deepEqual(l.padding, [0, 20, 0, 0], '_paddingBottom 20 → [L,B,R,T]');
  assert.equal(l.resizeMode, 'Container', '_resizeMode 1 → 容器随内容');
  assert.equal(l.childAlignment, 'UpperLeft', '默认 TOP_TO_BOTTOM + LEFT_TO_RIGHT');
}
// home view/_nd:content: 垂直 Container, 无 spacing/padding → 0/[0,0,0,0]
{
  const l = comp(findNode(home.root, '_scroll:content', 'view'), 'Layout').props;
  assert.equal(l.layoutType, 'Vertical');
  assert.equal(l.spacing, 0);
  deepEqual(l.padding, [0, 0, 0, 0]);
  assert.equal(l.resizeMode, 'Container');
}
// battle _nd:red_card_layer: _layoutType 1(水平) _spacingX 11 → Horizontal/spacing 11
{
  const l = comp(findNode(battle.root, 'zd_graph_red', '_nd:red_card_layer'), 'Layout').props;
  assert.equal(l.layoutType, 'Horizontal');
  assert.equal(l.spacing, 11, '_spacingX');
  assert.equal(l.resizeMode, 'Container');
  assert.equal(l.childAlignment, 'UpperLeft');
}
// _affectedByScale → 无 UGUI 等价, 记录 unmapped
assert.ok(battle.unmapped.some(u => u.component === 'cc.Layout._affectedByScale'),
  'affectedByScale 记录到 unmapped');

// ── Mask → RectMask2D; ScrollView → ScrollRect ────────────────────────────
{
  assert.ok(comp(findNode(home.root, '_scroll:content'), 'RectMask2D'), 'scroll 节点 RectMask2D');
  const sr = comp(findNode(home.root, '_scroll:content'), 'ScrollRect').props;
  assert.equal(sr.content, 'view', 'content=结构推断的第一个带 Layout 子节点');
  assert.equal(sr.horizontal, false, 'horizontal:false 直拷');
  assert.equal(sr.vertical, true, '缺省 vertical → true');
  assert.equal(sr.movementType, 'Elastic', 'bounceDuration 0.23 → Elastic');
}
console.log('t5-label-layout-opacity: 全部通过');
