#!/usr/bin/env node
// ============================================================================
// normalize-names.mjs — P7 命名规范化层：把 build/*.build.json 的节点名统一为
// 参照工程(参考模板工程)的 UI 命名规范（详见 UI-NAMING-SPEC.md）：
//   根名不变(=panel id)；节点 snake_case 小写 + 角色前缀(img_/lbl_/btn_/item_/fx_)；
//   剥离 Cocos 源命名标记(_nd:/_lab:/_spr:/_btn:/_arr:/_sp:/_spine:/_rt:/_pro:/_edx: 与 p_ 属性式)；
//   高频词干词典；滚动脚手架对齐 Unity 默认名(Viewport/Content)；同父同名去重(_2..n)；
//   同步 ScrollRect.content 按名引用；输出脚本信息 sidecar JSON（供模板架构适配）。
//
// 用法: node normalize-names.mjs [--dry] [--only <panelId> ...]（可多个 --only）
//       默认就地改写 build/*.build.json，首跑自动备份原名到 build-raw/
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const dirIdx = args.indexOf('--dir');
const dirArg = dirIdx >= 0 ? args[dirIdx + 1] : null;
if (dirIdx >= 0) args.splice(dirIdx, 2);
const dry = args.includes('--dry');
const onlys = args.filter((a, i) => args[i - 1] === '--only');
const here = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = path.resolve(here, dirArg || 'build');
const RAW_DIR = BUILD_DIR + '-raw';
const SIDECAR_DIR = path.resolve(here, 'sidecars');

// ---- 规则表（依据: 参考模板工程 参照工程 194 prefab 命名统计 + Cocos 源命名标记体系） ----
const MARKER_ROLE = { nd: '', spr: 'img', sp: 'img', lab: 'lbl', btn: 'btn', arr: 'item', spine: 'fx', rt: 'lbl', pro: '', edx: '' };
const COLON_MARKERS = new Set(['_nd', 'nd', '_spr', 'spr', '_sp', 'sp', '_lab', 'lab', '_btn', 'btn', '_arr', 'arr', '_spine', 'spine', '_rt', 'rt', '_pro', 'pro', '_edx', 'edx']);
const P_TOKENS = '(?:arr|spr|sp|lab|btn|nd|spine|rt|pro|edx)';
const STEM_DICT = { label: 'text', lab: 'text', txt: 'text', des: 'desc', titile: 'title' };
const STRUCT = new Set(['root', 'bg', 'panel', 'center', 'content', 'title', 'item', 'mask', 'view', 'viewport', 'frame', 'widget', 'red', 'red_dot', 'avatar', 'layout', 'top', 'down', 'left', 'right']);

const camel = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2');
const snake = (s) => camel(s).toLowerCase().replace(/[^0-9a-z_]+/g, '_').replace(/^_+|_+$/g, '');
const safeStem = (s) => (/^[0-9]/.test(s) ? '_' + s : s);
const isMarker = (s) => COLON_MARKERS.has(s) || COLON_MARKERS.has(s.replace(/^_/, ''));

/** 原始节点名 -> {role, stem} */
function parseName(raw) {
  const name = String(raw || '');
  // p_ 属性式: p_lab_cur_score / p_arr_spr_bg
  let pm = name.match(new RegExp(`^p_((${P_TOKENS}_)+)(.+)$`));
  if (pm) {
    let role = '';
    for (const t of pm[1].replace(/_$/, '').split('_')) {
      if (t === 'arr') role = 'item';
      else if (MARKER_ROLE[t]) role = MARKER_ROLE[t];
    }
    return { role, stem: snake(pm[3]) };
  }
  // 冒号链: _arr:spr:bg1 / _lab:dialog / _spine:anim / _nd:_spr:icon
  if (name.includes(':')) {
    const segs = name.split(':').filter(Boolean);
    let role = '';
    for (const seg of segs) {
      if (isMarker(seg)) {
        const key = seg.replace(/^_/, '');
        if (key === 'arr') role = 'item';
        else if (MARKER_ROLE[key]) role = MARKER_ROLE[key];
      }
    }
    const nonMark = segs.filter(s => !isMarker(s));
    const stem = nonMark.length ? nonMark[nonMark.length - 1] : '';
    return { role, stem: snake(stem) };
  }
  return { role: '', stem: snake(name) };
}

/** 无标记时按组件推断角色 */
function roleFromComponents(node) {
  const types = (node.components || []).map(c => c && c.type).filter(Boolean);
  if (types.includes('Button')) return 'btn';
  if (types.includes('Text')) return 'lbl';
  if (types.includes('Image')) return 'img';
  return '';
}

const FALLBACK_STEM = { img: 'img', lbl: 'text', btn: 'btn', item: 'item', fx: 'fx', '': 'node' };

/** 单节点最终命名（usedNames 为同父已用名集合） */
function renameNode(node, isRoot, usedNames) {
  const raw = node.name || '';
  if (isRoot) return raw; // 根名 = prefab 资产名，不改
  let { role, stem } = parseName(raw);
  stem = STEM_DICT[stem] || stem;
  const types = (node.components || []).map(c => c && c.type).filter(Boolean);
  // 滚动脚手架对齐 Unity 默认名
  if (types.includes('RectMask2D')) return uniq('Viewport', usedNames);
  if (!role && STRUCT.has(stem)) {
    if (stem === 'content' && types.includes('Layout')) return uniq('Content', usedNames);
    return uniq(stem, usedNames);
  }
  if (types.includes('ScrollRect') && (stem === 'scrollview' || stem === 'scroll_view' || stem === '')) stem = 'scroll_view';
  if (!role) role = roleFromComponents(node);
  if (!stem) stem = FALLBACK_STEM[role] || 'node';
  // 幂等：词干已带同角色前缀时不再叠加（img_bg1 -> img_bg1 而非 img_img_bg1）
  if (role && (stem === role || stem.startsWith(role + '_'))) return uniq(stem, usedNames);
  const name = (role ? role + '_' : '') + safeStem(stem);
  return uniq(name, usedNames);
  function uniq(base, used) {
    if (!used.has(base)) { used.add(base); return base; }
    let i = 2, n = base + '_' + i;
    while (used.has(n)) n = base + '_' + (++i);
    used.add(n); return n;
  }
}

// ---- 主流程 ----
const files = fs.readdirSync(BUILD_DIR).filter(f => f.endsWith('.build.json')).sort()
  .filter(f => onlys.length === 0 || onlys.some(o => f === o + '.build.json' || f.startsWith(o + '-')));
if (files.length === 0) { console.error('未匹配到面板。--only 用 panel id（如 demo-panel）'); process.exit(2); }

const stats = { panels: 0, nodes: 0, renamed: 0, scripts: 0 };
const summary = [];
if (!dry) { fs.mkdirSync(RAW_DIR, { recursive: true }); fs.mkdirSync(SIDECAR_DIR, { recursive: true }); }

for (const f of files) {
  const p = path.join(BUILD_DIR, f);
  const bj = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!dry && !fs.existsSync(path.join(RAW_DIR, f))) fs.copyFileSync(p, path.join(RAW_DIR, f));

  const pathOf = new Map();     // node -> 新路径
  const refsToFix = [];         // {comp, oldName}（ScrollRect.content 等按名引用）
  const oldNameOf = new Map();  // node -> 原名
  let panelNodes = 0, panelRenamed = 0;
  const sidecar = [];

  const walk = (node, parentPath, used) => {
    stats.nodes++; panelNodes++;
    oldNameOf.set(node, node.name);
    const newName = renameNode(node, parentPath === null, used);
    if (newName !== node.name) { stats.renamed++; panelRenamed++; }
    node.name = newName;
    const cur = parentPath === null ? newName : parentPath + '/' + newName;
    pathOf.set(node, cur);
    for (const c of node.components || []) {
      if (!c) continue;
      if (c.type === 'CustomScript') sidecar.push({ path: cur, node: oldNameOf.get(node), script: (c.props && c.props.script) || null, fields: (c.props && c.props.fields) || null });
      if (c.type === 'ScrollRect' && c.props && typeof c.props.content === 'string') refsToFix.push({ comp: c, oldName: c.props.content });
    }
    const childUsed = new Set();
    for (const ch of (node.children || [])) walk(ch, cur, childUsed);
  };
  walk(bj.root, null, new Set());

  // 引用同步：在全树范围按 原名+组件特征 定位目标节点（content 通常带 Layout；同名兄弟时取首个匹配）
  for (const r of refsToFix) {
    let target = null;
    (function seek(n) {
      if (target) return;
      if (oldNameOf.get(n) === r.oldName) { target = n; return; }
      for (const ch of (n.children || [])) seek(ch);
    })(bj.root);
    if (target) r.comp.props.content = target.name;
  }

  stats.panels++; stats.scripts += sidecar.length;
  summary.push({ panel: bj.meta.panel, nodes: panelNodes, renamed: panelRenamed, scripts: sidecar.length });
  if (!dry) {
    fs.writeFileSync(p, JSON.stringify(bj));
    fs.writeFileSync(path.join(SIDECAR_DIR, bj.meta.panel + '.scripts.json'),
      JSON.stringify({ panel: bj.meta.panel, generatedAt: new Date().toISOString(), scripts: sidecar }, null, 1));
  }
}

console.log(`${dry ? '[DRY] ' : ''}面板 ${stats.panels} | 节点 ${stats.nodes} | 改名 ${stats.renamed} (${(100 * stats.renamed / stats.nodes).toFixed(1)}%) | 脚本条目(sidecar) ${stats.scripts}`);
console.log(JSON.stringify(summary));
if (!dry && onlys.length) console.log(`已就地改写 build/ 下 ${files.length} 个文件（原件备份于 build-raw/）`);
