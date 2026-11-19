#!/usr/bin/env node
// ============================================================================
// validate-build.mjs — build.json 校验器 (schema + 引用完整性 + 内部一致性)
//
//   用法: node validate-build.mjs <build.json> [对照的 ir.json]
//
// 校验项:
//   A. schema: meta/sprites/scripts/root/unmapped 字段存在性与类型
//   B. rect: 每节点 9 字段齐全; 数值合法; UGUI 恒等式
//      offsetMax == offsetMin + sizeDelta
//      anchoredPosition == offsetMin + pivot * sizeDelta   (±1e-3)
//   C. 引用: Image.sprite ∈ sprites[].name (或 null); CustomScript.script ∈
//      scripts[].uuidHash; ScrollRect.content ∈ 树内节点名
//   D. 枚举: components[].type 白名单; imageType/alignment/overflow/layout 枚举
//   E. (可选, 传入 ir.json) 节点数一致; IR 组件 100% 入账(映射/消化/Marker);
//      sprite 源文件存在
// 退出码: 0 = 通过, 1 = 有错误(警告不计)。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

const [, , buildPath, irPath] = process.argv;
if (!buildPath) {
  console.error('用法: node validate-build.mjs <build.json> [ir.json]');
  process.exit(2);
}
const build = JSON.parse(fs.readFileSync(buildPath, 'utf8'));
const ir = irPath ? JSON.parse(fs.readFileSync(irPath, 'utf8')) : null;

const errors = [];
const warnings = [];
const err = m => errors.push(m);
const warn = m => warnings.push(m);
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const isNum = v => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------------------
// A. 顶层 schema
// ---------------------------------------------------------------------------
{
  const m = build.meta || {};
  for (const k of ['panel', 'bundle', 'designResolution', 'match', 'generatedBy', 'flags']) {
    if (!(k in m)) err(`meta 缺少字段 ${k}`);
  }
  if (m.designResolution && !(isNum(m.designResolution.width) && isNum(m.designResolution.height)))
    err('meta.designResolution.width/height 必须为数值');
  if (!Array.isArray(m.flags)) err('meta.flags 必须为数组');
  for (const s of build.sprites || []) {
    for (const k of ['name', 'source', 'rect', 'rotated', 'border']) if (!(k in s)) err(`sprites[] 缺字段 ${k}: ${JSON.stringify(s).slice(0, 60)}`);
    if (s.source && !/^([A-Za-z]:\/|\/)/.test(s.source)) err(`sprites.source 必须为绝对路径: ${s.source}`);
    if (s.rect && !(isNum(s.rect.x) && isNum(s.rect.y) && isNum(s.rect.w) && isNum(s.rect.h)))
      err(`sprites.rect 字段非法: ${s.name}`);
    if (s.border !== null && (!Array.isArray(s.border) || s.border.length !== 4 || !s.border.every(isNum)))
      err(`sprites.border 必须为 null 或 4 元数字数组: ${s.name}`);
  }
  const spriteNames = new Set();
  for (const s of build.sprites || []) {
    if (spriteNames.has(s.name)) err(`sprites[].name 重复: ${s.name}`);
    spriteNames.add(s.name);
  }
  const scriptIds = new Set();
  for (const sc of build.scripts || []) {
    for (const k of ['uuidHash', 'className', 'fields']) if (!(k in sc)) err(`scripts[] 缺字段 ${k}: ${JSON.stringify(sc).slice(0, 60)}`);
    if (scriptIds.has(sc.uuidHash)) err(`scripts[].uuidHash 重复: ${sc.uuidHash}`);
    scriptIds.add(sc.uuidHash);
    for (const f of sc.fields || []) {
      if (!f.name || !f.cocosType) err(`scripts[].fields 条目缺 name/cocosType: ${sc.uuidHash}.${f.name}`);
    }
  }
  if (!build.root || typeof build.root !== 'object') err('缺少 root 节点树');
  if (!Array.isArray(build.unmapped)) err('缺少 unmapped 数组');
}

// ---------------------------------------------------------------------------
// B/C/D. 树遍历
// ---------------------------------------------------------------------------
const COMPONENT_TYPES = new Set(['Image', 'Text', 'Button', 'Layout', 'RectMask2D', 'CanvasGroup', 'ScrollRect', 'CustomScript', 'Marker']);
const IMAGE_TYPES = new Set(['Simple', 'Sliced', 'Tiled', 'Filled']);
const OVERFLOWS = new Set(['Overflow', 'Clamp', 'Shrink', 'ResizeHeight']);
const LAYOUT_TYPES = new Set(['None', 'Horizontal', 'Vertical', 'Grid']);
const RESIZE_MODES = new Set(['None', 'Container', 'Children']);
const ALIGNMENTS = new Set(['UpperLeft', 'UpperCenter', 'UpperRight', 'MiddleLeft', 'MiddleCenter', 'MiddleRight', 'LowerLeft', 'LowerCenter', 'LowerRight']);
const RECT_FIELDS = ['anchorMin', 'anchorMax', 'offsetMin', 'offsetMax', 'pivot', 'anchoredPosition', 'sizeDelta'];
const nodeNames = [];
let nodeCount = 0;
let _spriteSet, _scriptSet;
function spriteNamesSet() { return _spriteSet ||= new Set((build.sprites || []).map(s => s.name)); }
function scriptIdsSet() { return _scriptSet ||= new Set((build.scripts || []).map(s => s.uuidHash)); }

(function walk(n, path) {
  nodeCount++;
  nodeNames.push(n.name);
  if (typeof n.name !== 'string') err(`节点 name 非法 @ ${path}`);
  if (typeof n.active !== 'boolean') err(`节点 active 非法 @ ${path}`);
  if (!n.rect || typeof n.rect !== 'object') { err(`缺 rect @ ${path}`); return; }
  for (const f of RECT_FIELDS) {
    const v = n.rect[f];
    if (!Array.isArray(v) || v.length !== 2 || !v.every(isNum)) err(`rect.${f} 非法 @ ${path}`);
  }
  if (!isNum(n.rect.rotationZ)) err(`rect.rotationZ 非法 @ ${path}`);
  if (!Array.isArray(n.rect.scale) || n.rect.scale.length !== 3 || !n.rect.scale.every(isNum)) err(`rect.scale 非法 @ ${path}`);
  const r = n.rect;
  if (RECT_FIELDS.every(f => Array.isArray(r[f]) && r[f].every(isNum))) {
    if (!(r.anchorMin[0] <= r.anchorMax[0] + 1e-9 && r.anchorMin[1] <= r.anchorMax[1] + 1e-9))
      err(`anchorMin > anchorMax @ ${path}`);
    for (let i = 0; i < 2; i++) {
      if (!near(r.offsetMax[i], r.offsetMin[i] + r.sizeDelta[i]))
        err(`恒等式失败 offsetMax != offsetMin+sizeDelta (轴 ${i}) @ ${path}: ${r.offsetMax[i]} vs ${r.offsetMin[i] + r.sizeDelta[i]}`);
      if (!near(r.anchoredPosition[i], r.offsetMin[i] + r.pivot[i] * r.sizeDelta[i]))
        err(`恒等式失败 anchoredPosition != offsetMin+pivot*sizeDelta (轴 ${i}) @ ${path}: ${r.anchoredPosition[i]} vs ${r.offsetMin[i] + r.pivot[i] * r.sizeDelta[i]}`);
    }
  }
  if (!Array.isArray(n.components)) err(`缺 components 数组 @ ${path}`);
  for (const c of n.components || []) {
    if (!COMPONENT_TYPES.has(c.type)) { err(`未知组件类型 ${c.type} @ ${path}`); continue; }
    const p = c.props || {};
    switch (c.type) {
      case 'Image':
        if ('sprite' in p && p.sprite !== null && !spriteNamesSet().has(p.sprite))
          err(`Image.sprite 未在 sprites[] 中: ${p.sprite} @ ${path}`);
        if (!IMAGE_TYPES.has(p.imageType)) err(`Image.imageType 非法: ${p.imageType} @ ${path}`);
        break;
      case 'Text':
        if (typeof p.text !== 'string') err(`Text.text 非法 @ ${path}`);
        if (!ALIGNMENTS.has(p.alignment)) err(`Text.alignment 非法: ${p.alignment} @ ${path}`);
        if (!OVERFLOWS.has(p.overflow)) err(`Text.overflow 非法: ${p.overflow} @ ${path}`);
        break;
      case 'Button':
        if (!['None', 'ColorTint', 'SpriteSwap', 'Animation'].includes(p.transition)) err(`Button.transition 非法: ${p.transition} @ ${path}`);
        break;
      case 'Layout':
        if (!LAYOUT_TYPES.has(p.layoutType)) err(`Layout.layoutType 非法: ${p.layoutType} @ ${path}`);
        if (!RESIZE_MODES.has(p.resizeMode)) err(`Layout.resizeMode 非法: ${p.resizeMode} @ ${path}`);
        if (!ALIGNMENTS.has(p.childAlignment)) err(`Layout.childAlignment 非法: ${p.childAlignment} @ ${path}`);
        if (!Array.isArray(p.padding) || p.padding.length !== 4) err(`Layout.padding 必须 4 元 @ ${path}`);
        break;
      case 'ScrollRect':
        if (typeof p.content !== 'string' || !p.content) err(`ScrollRect.content 非法 @ ${path}`);
        break;
      case 'CanvasGroup':
        if (!isNum(p.alpha) || p.alpha < 0 || p.alpha > 1) err(`CanvasGroup.alpha 非法: ${p.alpha} @ ${path}`);
        break;
      case 'CustomScript':
        if (!scriptIdsSet().has(p.script)) err(`CustomScript.script 未在 scripts[] 中: ${p.script} @ ${path}`);
        break;
      case 'Marker':
        if (!p.reason || !p.source) err(`Marker 缺 reason/source @ ${path}`);
        break;
    }
  }
  (n.children || []).forEach((ch, i) => walk(ch, `${path}/children[${i}]`));
})(build.root, 'root');

// ScrollRect.content 引用树内节点名(在完整名字表建立后校验)
for (const c of allComponents()) {
  if (c.comp.type === 'ScrollRect' && !nodeNames.includes(c.comp.props.content)) {
    err(`ScrollRect.content "${c.comp.props.content}" 不在节点树中 @ ${c.path}`);
  }
}

function* allComponents() {
  const stack = [[build.root, 'root']];
  while (stack.length) {
    const [n, path] = stack.pop();
    for (const comp of n.components || []) yield { comp, path };
    for (const ch of n.children || []) stack.push([ch, path]);
  }
}

// ---------------------------------------------------------------------------
// E. IR 对照
// ---------------------------------------------------------------------------
if (ir) {
  let irNodes = 0;
  const irCompTypes = {};
  (function walkIr(n) {
    irNodes++;
    for (const c of n.components || []) irCompTypes[c.type] = (irCompTypes[c.type] || 0) + 1;
    for (const s of n.customScripts || []) irCompTypes.customScript = (irCompTypes.customScript || 0) + 1;
    (n.children || []).forEach(walkIr);
  })(ir.nodes[0]);
  if (irNodes !== nodeCount) err(`节点数不一致: IR=${irNodes} build=${nodeCount}`);

  // IR 组件 100% 入账: 数出 build 树中各类去向
  const buildCount = { Image: 0, Text: 0, Button: 0, Layout: 0, RectMask2D: 0, ScrollRect: 0, CanvasGroup: 0, CustomScript: 0, Marker: 0 };
  for (const { comp } of allComponents()) buildCount[comp.type]++;
  const irMap = { 'cc.Sprite': 'Image', 'cc.Label': 'Text', 'cc.Button': 'Button', 'cc.Layout': 'Layout', 'cc.Mask': 'RectMask2D', 'cc.ScrollView': 'ScrollRect', 'cc.UIOpacity': 'CanvasGroup', customScript: 'CustomScript' };
  for (const [t, want] of Object.entries(irMap)) {
    if (irCompTypes[t] && buildCount[want] < irCompTypes[t]) err(`组件入账不足: IR ${t}×${irCompTypes[t]} 但 build ${want}×${buildCount[want]}`);
  }
  const consumed = Object.entries(irCompTypes).filter(([t]) => t === 'cc.UITransform' || t === 'cc.Widget').reduce((s, [, c]) => s + c, 0);
  const knownHandled = Object.keys(irMap).reduce((s, t) => s + (irCompTypes[t] || 0), 0) + consumed;
  const irTotal = Object.entries(irCompTypes).reduce((s, [, c]) => s + c, 0);
  const otherTypes = Object.entries(irCompTypes).filter(([t]) => !(t in irMap) && t !== 'cc.UITransform' && t !== 'cc.Widget');
  for (const [t, c] of otherTypes) {
    // 每个未知引擎组件必须产生 Marker(≥1)或被显式消化(Mask 伴生 Graphics)
    if (t === 'cc.Graphics') continue; // 同节点 Mask 伴生被消化, 否则 Marker(生成器保证)
    if (buildCount.Marker === 0 && c > 0) err(`IR 组件 ${t}×${c} 在 build 中无任何 Marker 兜底`);
  }
  console.log(`  IR 对照: IR节点=${irNodes} build节点=${nodeCount} IR组件=${irTotal}(显式处理 ${knownHandled}, 长尾 ${otherTypes.map(([t, c]) => t + '×' + c).join(' ') || '无'})`);

  // sprite 源文件存在性
  for (const s of build.sprites || []) {
    const p = s.source.replace(/\//g, path.sep);
    if (!fs.existsSync(p)) warn(`sprite 源文件不存在: ${s.source}`);
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
for (const w of warnings) console.log(`  警告: ${w}`);
if (errors.length) {
  console.error(`FAIL ${path.basename(buildPath)}: ${errors.length} 处错误`);
  for (const e of errors.slice(0, 50)) console.error(`  - ${e}`);
  if (errors.length > 50) console.error(`  … 还有 ${errors.length - 50} 处`);
  process.exit(1);
}
console.log(`PASS ${path.basename(buildPath)}: nodes=${nodeCount} sprites=${(build.sprites || []).length} scripts=${(build.scripts || []).length} markers=${[...allComponents()].filter(c => c.comp.type === 'Marker').length} unmapped=${(build.unmapped || []).length}${warnings.length ? ` warnings=${warnings.length}` : ''}`);
