#!/usr/bin/env node
// ============================================================================
// map-to-ugui.mjs — P3 映射转换器: Cocos IR (IR-SCHEMA.md) → UGUI build.json
// (BUILD-SCHEMA.md)。零依赖, node 26。
//
//   用法: node map-to-ugui.mjs <ir.json> [--out cocos2ugui/build/xx.build.json]
//
// 规则依据与实证见 rules.md。rect 全部为最终 UGUI 语义值, P4 不做任何数学。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GENERATOR = 'map-to-ugui v1';

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------
const argv = process.argv.slice(2);
const irPath = argv.find(a => !a.startsWith('--'));
const outIdx = argv.indexOf('--out');
const outArg = outIdx >= 0 ? argv[outIdx + 1] : null;
if (!irPath) {
  console.error('用法: node map-to-ugui.mjs <ir.json> [--out build/xx.json]');
  process.exit(2);
}
const ir = JSON.parse(fs.readFileSync(irPath, 'utf8'));
const panelId = (ir.meta.bundle && ir.meta.prefabName)
  ? `${ir.meta.bundle}-${ir.meta.prefabName}`
  : path.basename(irPath).replace(/\.json$/, '');
const outPath = outArg
  ? (path.isAbsolute(outArg) ? outArg : path.join(process.cwd(), outArg))
  : path.join(SCRIPT_DIR, 'build', `${panelId}.build.json`);

// ----------------------------------------------------------------------------
// 工具
// ----------------------------------------------------------------------------
const r4 = v => Math.round(v * 10000) / 10000;          // 保留 4 位小数, 消浮点噪声
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// gamecaches 根目录 = meta.sourceAbs 去掉 meta.source 尾段(仅分隔符不同)
function gamecachesRoot(meta) {
  const absDir = path.dirname(meta.sourceAbs).split(/[\\/]/);
  const relDir = path.dirname(meta.source).split('/');
  const rootSegs = absDir.slice(0, absDir.length - relDir.length);
  return rootSegs.join('/') + '/';
}
function absPath(root, relFile) {
  return root + String(relFile).replace(/\\/g, '/');     // node 内统一 C:/ 风格
}

// ----------------------------------------------------------------------------
// Cocos Widget._alignFlags 位定义 (引擎 cocos/ui/widget-component.ts 枚举,
// 自 2.x 沿用: TOP=1 MID=2 BOT=4 LEFT=8 CENTER=16 RIGHT=32)。
// 实证: 三样例中 45=四边拉伸(root)、1=贴顶、5=纵向拉伸、41=横向拉伸+贴顶,
//       与节点实际尺寸/位置全部吻合(见 rules.md §2)。
// ----------------------------------------------------------------------------
const WF = { TOP: 1, MID: 2, BOT: 4, LEFT: 8, CENTER: 16, RIGHT: 32 };

// 四元数 → Z 轴角度(度)。Cocos/UGUI 屏幕坐标同为 X右 Y上, 正角同为逆时针,
// 数值可直接搬运(样例中全为恒等四元数)。
function quatToZDeg(q) {
  if (!q || (q.x === 0 && q.y === 0 && q.z === 0 && (q.w === 1 || q.w == null))) return 0;
  const { x = 0, y = 0, z = 0, w = 1 } = q;
  if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) return r4((2 * Math.atan2(z, w)) * 180 / Math.PI);
  return r4(Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * 180 / Math.PI);
}

function vec2(v, d) { return v ? { x: num(v.x), y: num(v.y) } : { x: d, y: d }; }
function colToArr(c) {
  if (!c) return [1, 1, 1, 1];
  return [num(c.r) / 255, num(c.g) / 255, num(c.b) / 255, num(c.a) / 255].map(r4);
}

// ----------------------------------------------------------------------------
// 面板级状态
// ----------------------------------------------------------------------------
const spriteRegistry = new Map();   // name → sprites[] 条目
const scriptRegistry = new Map();   // uuidHash → scripts[] 条目
const unmapped = [];                // {node, component, reason}
const coverage = { nodes: 0, byType: {}, notes: [] };
const fontUsed = {};                // 位图字体使用统计 → 面板级聚合 unmapped 条目
function cov(type, disposition, node, reason) {
  const e = (coverage.byType[type] ||= { mapped: 0, marker: 0, consumed: 0, detail: [] });
  e[disposition] += 1;
  if (reason) e.detail.push(`${node}: ${reason}`);
}

const panelFlags = new Set();
const gcRoot = gamecachesRoot(ir.meta);

function noteUnmapped(node, component, reason) {
  unmapped.push({ node, component, reason });
}

// ----------------------------------------------------------------------------
// sprites / scripts 注册
// ----------------------------------------------------------------------------
function registerSprite(assetIndex) {
  if (assetIndex == null) return null;
  const a = ir.assets[assetIndex];
  if (!a || !a.sprite) return null;
  let name = a.sprite.name || a.uuid.split('@')[0].slice(-8);
  if (spriteRegistry.has(name)) {
    const existing = spriteRegistry.get(name);
    if (existing.source !== absPath(gcRoot, a.file)) {
      let i = 2;
      while (spriteRegistry.has(`${name}-${i}`)) i++;
      name = `${name}-${i}`;
    }
  }
  // capInsets = [L, T, R, B](引擎 3.8.8 sprite-frame.ts: INSET_LEFT/TOP/RIGHT/BOTTOM
  // 数组直存) → Unity border [L,B,R,T]; 全 0 → null(非九宫格)。
  const cap = a.sprite.capInsets || [0, 0, 0, 0];
  const border = (cap[0] || cap[1] || cap[2] || cap[3])
    ? [num(cap[0]), num(cap[3]), num(cap[2]), num(cap[1])]
    : null;
  const entry = {
    name,
    source: absPath(gcRoot, a.file),
    rect: { x: num(a.sprite.rect.x), y: num(a.sprite.rect.y), w: num(a.sprite.rect.width), h: num(a.sprite.rect.height) },
    rotated: a.sprite.rotated === true,
    border,
  };
  spriteRegistry.set(name, entry);
  return name;
}

function pascal(s) {
  return String(s).replace(/[^0-9a-zA-Z]+/g, '_').split('_')
    .filter(Boolean).map(p => p[0].toUpperCase() + p.slice(1)).join('');
}
// 自定义脚本字段名 → Cocos 组件类型推断(项目命名约定 p_nd_/p_spr_/p_lab_..., 
// 与样例节点名 100% 对得上, 见 rules.md §10)
function inferCocosType(fieldName, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if ('$inst' in value) {
      if (fieldName.startsWith('p_nd_')) return 'cc.Node';
      if (fieldName.startsWith('p_spr_')) return 'cc.Sprite';
      if (fieldName.startsWith('p_lab_')) return 'cc.Label';
      if (fieldName.startsWith('p_btn_')) return 'cc.Button';
      if (fieldName.startsWith('p_pro_')) return 'cc.ProgressBar';
      if (fieldName.startsWith('p_spine_')) return 'sp.Skeleton';
      if (fieldName.startsWith('p_scroll_')) return 'cc.ScrollView';
      return 'cc.Node/Component';
    }
    if ('$asset' in value) return 'cc.Prefab';
    return 'json';
  }
  if (Array.isArray(value)) return 'json';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'unknown';
}
function fieldTooltip(fieldName, value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && '$inst' in value) {
    const guess = fieldName.replace(/^p_(nd|spr|lab|btn|pro|spine|scroll)_/, (m, p) =>
      ({ nd: '_nd:', spr: '_spr:', lab: '_lab:', btn: '_btn:', pro: '_pro:', spine: '_spine:', scroll: '_scroll:' }[p]));
    return `IR $inst ${value.$inst} 引用${guess !== fieldName ? ` (按名推断节点 ${guess})` : ''}`;
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && '$asset' in value) {
    const a = ir.assets[value.$asset];
    return `prefab 资产引用 ${a ? a.uuid : value.uuid}`;
  }
  return `原值: ${JSON.stringify(value)}`;
}
function registerScript(script, node) {
  const uuidHash = script.uuid;
  if (!scriptRegistry.has(uuidHash)) {
    scriptRegistry.set(uuidHash, {
      uuidHash,
      className: `${pascal(ir.meta.prefabName || panelId)}_${uuidHash.slice(0, 6)}`,
      fields: Object.entries(script.props || {}).map(([name, value]) => ({
        name,
        cocosType: inferCocosType(name, value),
        tooltip: fieldTooltip(name, value),
      })),
    });
  }
  return uuidHash;
}

// ----------------------------------------------------------------------------
// rect 计算 —— 本转换器的核心。
//
// 输入: 节点 UITransform(size/anchorPoint)、_lpos、可选 Widget;
//       父节点 anchor(=子节点无 Widget 轴的锚点) 与 size。
// 输出: 全 9 个 UGUI rect 字段, 满足恒等式(见 rules.md §1):
//       offsetMax = offsetMin + sizeDelta
//       anchoredPosition = offsetMin + pivot * sizeDelta
// ----------------------------------------------------------------------------
function computeRect({ size, anchor, lpos, widget, parentAnchor, parentSize }) {
  const w = size.w, h = size.h;
  const F = widget ? num(widget._alignFlags) : 0;
  // Widget 边距: 默认绝对像素; _isAbsXxx===false 时为父尺寸百分比
  const P = (name, isAbsName, parentExtent) => {
    const raw = num(widget ? widget[name] : 0);
    const abs = !widget || widget[isAbsName] === undefined ? true : widget[isAbsName] !== false;
    return abs ? raw : raw * parentExtent;
  };
  // 每轴产出 {aMin, aMax, lo, hi}: lo/hi 即 offsetMin/offsetMax 分量。
  const axis = {
    x() {
      const L = F & WF.LEFT, R = F & WF.RIGHT, C = F & WF.CENTER;
      if (L && R) return { aMin: 0, aMax: 1, lo: P('_left', '_isAbsLeft', parentSize.w), hi: -P('_right', '_isAbsRight', parentSize.w) };
      if (L) return { aMin: 0, aMax: 0, lo: P('_left', '_isAbsLeft', parentSize.w), hi: P('_left', '_isAbsLeft', parentSize.w) + w };
      if (R) return { aMin: 1, aMax: 1, hi: -P('_right', '_isAbsRight', parentSize.w), lo: -P('_right', '_isAbsRight', parentSize.w) - w };
      // CENTER: Widget 把节点中心对齐父中心(父空间内中心 = parentSize.w*(0.5-parentAnchor.x))
      let lx = lpos.x;
      if (C) lx = parentSize.w * (0.5 - parentAnchor.x);
      return { aMin: parentAnchor.x, aMax: parentAnchor.x, lo: lx - anchor.x * w, hi: lx - anchor.x * w + w };
    },
    y() {
      const T = F & WF.TOP, B = F & WF.BOT, M = F & WF.MID;
      if (T && B) return { aMin: 0, aMax: 1, lo: P('_bottom', '_isAbsBottom', parentSize.h), hi: -P('_top', '_isAbsTop', parentSize.h) };
      if (T) return { aMin: 1, aMax: 1, hi: -P('_top', '_isAbsTop', parentSize.h), lo: -P('_top', '_isAbsTop', parentSize.h) - h };
      if (B) return { aMin: 0, aMax: 0, lo: P('_bottom', '_isAbsBottom', parentSize.h), hi: P('_bottom', '_isAbsBottom', parentSize.h) + h };
      let ly = lpos.y;
      if (M) ly = parentSize.h * (0.5 - parentAnchor.y);
      return { aMin: parentAnchor.y, aMax: parentAnchor.y, lo: ly - anchor.y * h, hi: ly - anchor.y * h + h };
    },
  };
  const X = axis.x(), Y = axis.y();
  // 在"已舍入空间"里推导派生量, 保证 UGUI 恒等式在 4 位小数下严格成立:
  //   offsetMax == offsetMin + sizeDelta              (严格相等)
  //   anchoredPosition == offsetMin + pivot*sizeDelta (≤5e-5 舍入差)
  const offsetMinX = r4(X.lo), offsetMaxX = r4(X.hi);
  const offsetMinY = r4(Y.lo), offsetYMax = r4(Y.hi);
  const sizeW = r4(offsetMaxX - offsetMinX);
  const sizeH = r4(offsetYMax - offsetMinY);
  const pivotX = r4(anchor.x), pivotY = r4(anchor.y);
  return {
    anchorMin: [r4(X.aMin), r4(Y.aMin)],
    anchorMax: [r4(X.aMax), r4(Y.aMax)],
    offsetMin: [offsetMinX, offsetMinY],
    offsetMax: [offsetMaxX, offsetYMax],
    pivot: [pivotX, pivotY],
    anchoredPosition: [r4(offsetMinX + pivotX * sizeW), r4(offsetMinY + pivotY * sizeH)],
    sizeDelta: [sizeW, sizeH],
  };
}

// ----------------------------------------------------------------------------
// 组件映射
// ----------------------------------------------------------------------------
const SPRITE_TYPE = ['Simple', 'Sliced', 'Tiled', 'Filled'];
const LABEL_OVERFLOW = ['Overflow', 'Clamp', 'Shrink', 'ResizeHeight'];   // NONE/CLAMP/SHRINK/RESIZE_HEIGHT
const H_ALIGN = ['Left', 'Center', 'Right'];
const V_ALIGN = ['Upper', 'Middle', 'Lower'];                              // TOP/CENTER/BOTTOM
const BUTTON_TRANSITION = ['None', 'ColorTint', 'SpriteSwap', 'Animation'];

function mapComponents(node, nodePath, ctx) {
  const out = [];
  const comps = node.components || [];
  const hasMask = comps.some(c => c.type === 'cc.Mask');
  for (const comp of comps) {
    const p = comp.props || {};
    const name = nodePath;
    switch (comp.type) {
      case 'cc.UITransform':
        cov('cc.UITransform', 'consumed', name);
        break; // → rect (pivot/sizeDelta/anchoredPosition)
      case 'cc.Widget':
        cov('cc.Widget', 'consumed', name);
        break; // → rect (anchorMin/Max + offsetMin/Max)
      case 'cc.Sprite': {
        cov('cc.Sprite', 'mapped', name);
        const spriteName = p._spriteFrame ? registerSprite(p._spriteFrame.$asset) : null;
        if (p._spriteFrame && !spriteName) noteUnmapped(name, 'cc.Sprite._spriteFrame', 'spriteFrame 资产无 sprite 信息, 引用悬空');
        out.push({
          type: 'Image',
          props: {
            sprite: spriteName,
            imageType: SPRITE_TYPE[num(p._type)] || 'Simple',
            color: colToArr(p._color),
            raycastTarget: true,
          },
        });
        break;
      }
      case 'cc.Label': {
        cov('cc.Label', 'mapped', name);
        const fontSize = num(p._fontSize) || num(p._actualFontSize) || 20;
        out.push({
          type: 'Text',
          props: {
            text: p._string ?? '',
            fontSize,
            color: colToArr(p._color),
            alignment: `${V_ALIGN[num(p._verticalAlign)] || 'Upper'}${H_ALIGN[num(p._horizontalAlign)] || 'Left'}`,
            overflow: LABEL_OVERFLOW[num(p._overflow)] || 'Overflow',
            lineSpacing: p._lineHeight ? r4(num(p._lineHeight) / fontSize) : 1,
            richText: false, // cc.Label 无富文本(cc.RichText 为独立组件, 样例中未出现)
          },
        });
        if (p._enableOutline) {
          noteUnmapped(name, 'cc.Label.outline',
            `描边(宽 ${num(p._outlineWidth) || 2})无 UGUI Text 等价, 建议 P4 叠加 Shadow/Outline 组件`);
        }
        if (p._font) {
          const a = ir.assets[p._font.$asset];
          const fontKey = (a && a.name) || p._font.uuid;
          (fontUsed[fontKey] ||= { count: 0, uuid: p._font.uuid });
          fontUsed[fontKey].count++;
        }
        break;
      }
      case 'cc.Button': {
        cov('cc.Button', 'mapped', name);
        const trans = num(p._transition);
        if (trans === 3) {
          noteUnmapped(name, 'cc.Button._transition', `SCALE 缩放过渡(_zoomScale=${p._zoomScale})无 UGUI Button Transition 等价, 降级为 None`);
          out.push({ type: 'Button', props: { interactable: p._interactable !== false, transition: 'None' } });
        } else {
          out.push({ type: 'Button', props: { interactable: p._interactable !== false, transition: BUTTON_TRANSITION[trans] || 'None' } });
        }
        break;
      }
      case 'cc.Layout': {
        cov('cc.Layout', 'mapped', name);
        const type = num(p._layoutType); // 0 NONE 1 HORIZONTAL 2 VERTICAL 3 GRID
        const hDir = num(p._horizontalDirection);   // 0 L2R 1 R2L (默认 0)
        const vDir = num(p._verticalDirection);      // 0 T2B 1 B2T (默认 0, 实证见 rules.md §7)
        let childAlignment;
        const row = vDir === 1 ? 'Lower' : 'Upper';
        const col = hDir === 1 ? 'Right' : 'Left';
        if (type === 1) childAlignment = `${row}${col === 'Left' ? 'Left' : 'Right'}`;
        else if (type === 2) childAlignment = `${row}${col}`;
        else childAlignment = `${row}${col}`;
        out.push({
          type: 'Layout',
          props: {
            layoutType: ['None', 'Horizontal', 'Vertical', 'Grid'][type] || 'None',
            spacing: r4(type === 1 ? num(p._spacingX) : num(p._spacingY)),
            padding: [num(p._paddingLeft), num(p._paddingBottom), num(p._paddingRight), num(p._paddingTop)], // [L,B,R,T]
            childAlignment,
            resizeMode: ['None', 'Container', 'Children'][num(p._resizeMode)] || 'None',
          },
        });
        if (p._affectedByScale) {
          noteUnmapped(name, 'cc.Layout._affectedByScale', '布局受子节点缩放影响(UGUI LayoutGroup 忽略 scale), 间距会偏大');
        }
        break;
      }
      case 'cc.Mask': {
        cov('cc.Mask', 'mapped', name);
        out.push({ type: 'RectMask2D', props: {} });
        break;
      }
      case 'cc.Graphics': {
        // 实证: 样例中 Graphics 全部与 cc.Mask 同节点(2/2, home), 是 Mask 的模板
        // 绘制辅助件(仅 _fillColor 无路径数据) → 随 RectMask2D 一并消化。
        if (hasMask) { cov('cc.Graphics', 'consumed', name); break; }
        cov('cc.Graphics', 'marker', name);
        out.push({ type: 'Marker', props: { reason: 'cc.Graphics: 矢量绘制无 UGUI 等价', source: 'cc.Graphics' } });
        noteUnmapped(name, 'cc.Graphics', '矢量绘制无 UGUI 等价');
        break;
      }
      case 'cc.ScrollView': {
        cov('cc.ScrollView', 'mapped', name);
        // _content 是 $inst(指向原始 section 实例表, IR 未携带)。
        // 结构推断: ScrollView 节点子树中第一个带 Layout 的节点即滚动 content
        // (Cocos 模板惯例; 本样例唯一子节点 view 带 Layout CONTAINER, 实证吻合)。
        let contentName = findScrollContent(node);
        if (!contentName) noteUnmapped(name, 'cc.ScrollView._content', '$inst 实例引用无法从 IR 解析且无带 Layout 的子节点, content 留空');
        out.push({
          type: 'ScrollRect',
          props: {
            content: contentName || '',
            horizontal: p.horizontal === true,
            vertical: p.vertical !== false,
            movementType: (num(p.bounceDuration) === 0 && p.bounceDuration !== undefined) ? 'Clamped' : 'Elastic',
          },
        });
        break;
      }
      case 'cc.UIOpacity': {
        cov('cc.UIOpacity', 'mapped', name);
        out.push({ type: 'CanvasGroup', props: { alpha: r4(num(p._opacity ?? 255) / 255), blocksRaycasts: true } });
        break;
      }
      case 'sp.Skeleton': {
        cov('sp.Skeleton', 'marker', name);
        panelFlags.add('no-spine-runtime');
        const sk = p._skeletonData && ir.assets[p._skeletonData.$asset];
        out.push({
          type: 'Marker',
          props: { reason: `sp.Skeleton: 需 spine-unity${sk && sk.name ? ` (${sk.name})` : ''}`, source: 'sp.Skeleton' },
        });
        noteUnmapped(name, 'sp.Skeleton', `spine 骨骼动画${sk && sk.name ? ` ${sk.name}` : ''}需 spine-unity 运行时, 原动画 defaultSkin=${p.defaultSkin} anim=${p.defaultAnimation}`);
        break;
      }
      case 'cc.ProgressBar': {
        cov('cc.ProgressBar', 'marker', name);
        out.push({
          type: 'Marker',
          props: { reason: `cc.ProgressBar: 无 UGUI 组件枚举位(需 Slider/自绘), progress=${num(p._progress)}`, source: 'cc.ProgressBar' },
        });
        noteUnmapped(name, 'cc.ProgressBar', `进度条无组件枚举位(总长 ${num(p._totalLength)}, 进度 ${num(p._progress)}); 底图/条 Sprite 已按 Image 映射`);
        break;
      }
      case 'cc.BlockInputEvents': {
        cov('cc.BlockInputEvents', 'marker', name);
        out.push({
          type: 'Marker',
          props: { reason: 'cc.BlockInputEvents: 拦截点击穿透(UGUI 由全屏 raycastTarget Image 承担)', source: 'cc.BlockInputEvents' },
        });
        noteUnmapped(name, 'cc.BlockInputEvents', '拦截点击穿透; UGUI 中全屏 Image(raycastTarget=true)天然拦截');
        break;
      }
      default: {
        cov(comp.type, 'marker', name);
        out.push({
          type: 'Marker',
          props: { reason: `${comp.type}: 无自动映射规则`, source: comp.type },
        });
        noteUnmapped(name, comp.type, `${comp.type} 无自动映射规则`);
        break;
      }
    }
  }
  // 自定义脚本 → CustomScript(引用 scripts[].uuidHash)
  for (const s of node.customScripts || []) {
    cov('customScript', 'mapped', nodePath);
    const uuidHash = registerScript(s, nodePath);
    out.push({ type: 'CustomScript', props: { script: uuidHash } });
  }
  return out;
}

// ScrollView content 结构推断: 子树(不含自身)中 BFS 序第一个带 cc.Layout 的节点
function findScrollContent(scrollNode) {
  const queue = [...(scrollNode.children || [])];
  while (queue.length) {
    const n = queue.shift();
    if ((n.components || []).some(c => c.type === 'cc.Layout')) return n.name;
    queue.push(...(n.children || []));
  }
  return null;
}

// ----------------------------------------------------------------------------
// 节点树转换
// ----------------------------------------------------------------------------
function convertNode(node, parentCtx, pathPrefix) {
  coverage.nodes++;
  const nodePath = pathPrefix ? `${pathPrefix}/${node.name}` : node.name;
  const uitProps = (node.components.find(c => c.type === 'cc.UITransform') || {}).props || {};
  const size = uitProps._contentSize
    ? { w: num(uitProps._contentSize.width), h: num(uitProps._contentSize.height) }
    : { w: 100, h: 100 }; // UITransform 默认 contentSize (cocos/2d/framework/ui-transform.ts)
  const anchor = vec2(uitProps._anchorPoint, 0.5);
  const lpos = node.position
    ? { x: num(node.position.x), y: num(node.position.y) }
    : { x: 0, y: 0 };
  const widgetComp = node.components.find(c => c.type === 'cc.Widget');
  const rect = computeRect({
    size, anchor, lpos,
    widget: widgetComp ? widgetComp.props || {} : null,
    parentAnchor: parentCtx.anchor,
    parentSize: parentCtx.size,
  });
  const components = mapComponents(node, nodePath, parentCtx);
  const children = (node.children || []).map(ch => convertNode(ch, { anchor, size }, nodePath));
  return {
    name: node.name,
    active: node.active !== false,
    rect: {
      ...rect,
      rotationZ: quatToZDeg(node.rotation),
      scale: node.scale ? [r4(num(node.scale.x)) || 0, r4(num(node.scale.y)) || 0, 1] : [1, 1, 1],
    },
    components,
    children,
  };
}

// 根节点父环境 = Canvas(designResolution, 中心锚点)
const rootCtx = {
  anchor: { x: 0.5, y: 0.5 },
  size: { w: ir.meta.designResolution.width, h: ir.meta.designResolution.height },
};
const root = convertNode(ir.nodes[0], rootCtx, '');

// 位图字体: build.json 无字体表字段, 面板级聚合记录(非逐 Label 刷屏)
for (const [fontName, { count, uuid }] of Object.entries(fontUsed)) {
  noteUnmapped('(panel)', 'cc.Label._font', `位图字体 ${fontName}(${uuid}) 被 ${count} 个 Label 引用; BUILD-SCHEMA 无字体表, P4 需用默认动态字体或协商扩展 fonts[]`);
}

// ----------------------------------------------------------------------------
// 输出
// ----------------------------------------------------------------------------
const build = {
  meta: {
    panel: panelId,
    bundle: ir.meta.bundle,
    designResolution: { width: ir.meta.designResolution.width, height: ir.meta.designResolution.height },
    match: 1,
    generatedBy: GENERATOR,
    flags: [...panelFlags],
  },
  sprites: [...spriteRegistry.values()],
  scripts: [...scriptRegistry.values()],
  root,
  unmapped,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(build, null, 1) + '\n', 'utf8');

// 摘要
const compTotals = {};
(function count(n) {
  for (const c of n.components) compTotals[c.type] = (compTotals[c.type] || 0) + 1;
  n.children.forEach(count);
})(root);
console.log(`[${panelId}] nodes=${coverage.nodes} -> ${path.relative(process.cwd(), outPath)}`);
console.log(`  组件: ${Object.entries(compTotals).map(([k, v]) => `${k}×${v}`).join(' ')}`);
console.log(`  sprites=${build.sprites.length} scripts=${build.scripts.length} unmapped=${unmapped.length} flags=[${build.meta.flags.join(',')}]`);
const irCompTypes = Object.entries(ir.meta.stats.components);
const missing = irCompTypes.filter(([t]) => !(t in coverage.byType));
if (missing.length) console.log(`  警告: IR 组件类型未入账: ${missing.map(([t, c]) => `${t}×${c}`).join(' ')}`);
