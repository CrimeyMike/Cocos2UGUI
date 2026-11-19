#!/usr/bin/env node
// ============================================================================
// parse-editor-prefab.mjs — P1 编辑器入口：Cocos Creator 3.x 工程原生
// .prefab / .scene 文件(可读 JSON, __id__ 引用式) → IR 中间表示。
// 产出与 parse-prefab.mjs(解包入口) 完全同形的 IR —— P3(map-to-ugui) 起全链路复用。
//
// 格式实证: cocos/cocos-test-projects v3.8.7 (layout-scrollview.scene / loaditem.prefab
// / gold.png.meta), 见 docs/EDITOR-INPUT.md。要点:
//   * 顶层 JSON 数组, __id__ = 数组下标; 资产引用 {__uuid__}(完整连字符 uuid, @f9941 子资产)
//   * cc.Prefab@N.data.__id__ → 根节点; cc.SceneAsset → cc.Scene → 带 cc.Canvas 的 UI 子树
//   * 节点 _prefab:{__id__} → cc.PrefabInfo{asset,fileId}; 组件 __prefab:{__id__} → cc.CompPrefabInfo{fileId}
//   * 枚举为数字; Vec/Color/Size 自带 __type__ 标注(与 IR 值编码一致, 透传即可)
//   * 图片切图信息在 <file>.meta 的 subMetas["f9941"].userData
//     (trimX/trimY/width/height/rawWidth/rawHeight/offsetX/offsetY/rotated/borderLeft|Top|Right|Bottom)
//   * plist 图集: <name>.plist(TexturePacker XML frames) + <name>.plist.meta(每帧 border)
//
// 用法:
//   node parse-editor-prefab.mjs <file.prefab|.scene> [--out ir.json]
//        [--project <cocos工程根> 默认=输入文件上溯到含 package.json(creator 字段) 的目录]
//        [--bundle <name> 默认=输入文件相对 assets/ 的一级目录名或 'assets']
//        [--max-nest-depth 4] [--no-expand]
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isScriptClass = (t) => typeof t === 'string' && !t.includes('.'); // 与 parse-prefab.mjs 同判定
const BASE_UUID = (u) => (typeof u === 'string' && u.includes('@') ? u.slice(0, u.indexOf('@')) : u);
const SPRITE_FRAME_SUB = 'f9941', TEXTURE_SUB = '6c48a';

const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const inFile = path.resolve(argOf('--out') ? args[0] && path.resolve(args[0]) : args[0]);
if (!args[0] || !fs.existsSync(inFile)) {
  console.error('用法: node parse-editor-prefab.mjs <file.prefab|.scene> [--out ir.json] [--project <工程根>] [--bundle <name>] [--no-expand]');
  process.exit(2);
}
const outFile = argOf('--out');
const maxNestDepth = Number(argOf('--max-nest-depth') ?? 4) || 4;
const expandOn = !args.includes('--no-expand');

// ---------- 工程根定位 ----------
function findProjectRoot(fromFile) {
  let dir = path.dirname(fromFile);
  for (let i = 0; i < 12 && dir !== path.dirname(dir); i++) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try { if (JSON.parse(fs.readFileSync(pkg, 'utf8')).creator) return dir; } catch { /* 继续 */ }
    }
    if (fs.existsSync(path.join(dir, 'assets')) && fs.existsSync(path.join(dir, 'settings'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}
const projectRootIn = argOf('--project');
const projectRoot = projectRootIn ? path.resolve(projectRootIn) : findProjectRoot(inFile);

// ---------- 资产索引: uuid → {fileAbs, meta} (懒构建, 全工程 .meta 扫描) ----------
let assetIdx = null; // {images: Map(baseUuid->{fileAbs,meta}), plists: Map(...), all: Map(uuid->fileAbs)}
function buildAssetIndex() {
  const idx = { images: new Map(), plists: new Map(), others: new Map() };
  if (!projectRoot || !fs.existsSync(path.join(projectRoot, 'assets'))) return idx;
  const walk = (dir, depth) => {
    if (depth > 12) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(meta|pac)$/.test(e.name)) continue;
      else {
        const metaPath = full + '.meta';
        if (!fs.existsSync(metaPath)) continue;
        let meta;
        try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { continue; }
        if (!meta.uuid) continue;
        const rel = path.relative(projectRoot, full).split(path.sep).join('/');
        idx.others.set(meta.uuid, { fileRel: rel, meta });
        if (/\.(png|jpg|jpeg|webp)$/i.test(e.name)) idx.images.set(meta.uuid, { fileRel: rel, meta });
        if (/\.plist$/i.test(e.name)) idx.plists.set(meta.uuid, { fileRel: rel, meta, fileAbs: full });
      }
    }
  };
  walk(path.join(projectRoot, 'assets'), 0);
  return idx;
}
function assetIndex() { if (!assetIdx) assetIdx = buildAssetIndex(); return assetIdx; }

/** plist(TexturePacker XML) frames: {name: {frame:{x,y,w,h}, rotated, offset:{x,y}, sourceSize:{w,h}}} */
function parsePlistFrames(xml) {
  const out = {};
  const segStart = xml.indexOf('<key>frames</key>');
  if (segStart < 0) return out;
  let seg = xml.slice(segStart);
  const md = seg.indexOf('<key>metadata</key>');
  if (md > 0) seg = seg.slice(0, md);
  // 按帧名 key 分段(帧名后跟 <dict>, 值提取只在段内做)
  const frameNameRe = /<key>([^<]+\.(?:png|jpg|jpeg|webp))<\/key>/gi;
  const positions = [];
  let fm;
  while ((fm = frameNameRe.exec(seg)) !== null) positions.push({ name: fm[1], start: fm.index });
  const grab = (chunk, key) => {
    const m = chunk.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
    return m ? m[1] : null;
  };
  const nums = (s) => (String(s ?? '').match(/-?\d+(\.\d+)?/g) || []).map(Number);
  for (let i = 0; i < positions.length; i++) {
    const chunk = seg.slice(positions[i].start, i + 1 < positions.length ? positions[i + 1].start : seg.length);
    const fr = { rotated: /<key>rotated<\/key>\s*<true\/>/.test(chunk) };
    const f = nums(grab(chunk, 'frame'));
    if (f.length >= 4) fr.frame = { x: f[0], y: f[1], w: f[2], h: f[3] };
    const o = nums(grab(chunk, 'offset'));
    fr.offset = { x: o[0] || 0, y: o[1] || 0 };
    const ss = nums(grab(chunk, 'sourceSize'));
    if (ss.length >= 2) fr.sourceSize = { width: ss[0], height: ss[1] };
    if (fr.frame) out[positions[i].name] = fr;
  }
  return out;
}
const braces = (s) => { const n = (String(s).match(/-?\d+(\.\d+)?/g) || []).map(Number); return n; };

// ---------- IR 构建 ----------
const doc = JSON.parse(fs.readFileSync(inFile, 'utf8'));
if (!Array.isArray(doc)) { console.error('顶层不是 JSON 数组: ' + inFile); process.exit(1); }
const byId = doc;
const inst = (ref) => (ref && typeof ref === 'object' && '__id__' in ref ? byId[ref.__id__] : undefined);

const unresolved = [];
const fail = (location, reason, category = 'other') => unresolved.push({ location, reason, category });

const assets = [];
const _assetByUuid = new Map();
const stats = { nodes: 0, components: {}, customScripts: {}, spriteRefs: 0, spriteResolved: 0, nestedPrefabs: 0, overridesApplied: 0 };

function registerAsset(uuid, location) {
  if (_assetByUuid.has(uuid)) return _assetByUuid.get(uuid);
  const entry = { uuid, kind: 'unknown', name: null, file: null, exists: false };
  const idx = assets.push(entry) - 1;
  _assetByUuid.set(uuid, idx);
  try { fillAsset(entry, uuid, location); } catch (e) { fail(location, `资产解析异常 ${uuid}: ${e.message}`, 'asset'); }
  return idx;
}
function fillAsset(entry, uuid, location) {
  const idx = assetIndex();
  const sub = uuid.includes('@') ? uuid.slice(uuid.indexOf('@') + 1) : null;
  const base = BASE_UUID(uuid);
  if (sub === SPRITE_FRAME_SUB || (sub && sub !== TEXTURE_SUB && (idx.images.has(base) || idx.plists.has(base)))) {
    entry.kind = 'spriteFrame';
    const img = idx.images.get(base);
    const plist = idx.plists.get(base);
    if (plist) {
      // plist 图集帧: rect/rotated/offset/sourceSize ← plist.xml, border/capInsets ← plist.meta subMetas[sub].userData
      let frames = {};
      try { frames = parsePlistFrames(fs.readFileSync(plist.fileAbs, 'utf8')); }
      catch (e) { entry.note = `plist 解析失败: ${e.message}`; return; }
      // 帧名 → spriteFrame 子资产名: meta.subMetas 里找 id===sub 的条目 displayName
      const meta = plist.meta;
      let frameName = null, border = [0, 0, 0, 0];
      for (const [sk, sv] of Object.entries(meta.subMetas || {})) {
        if (sk === sub || sv.id === sub || sv.uuid === uuid) { frameName = sv.displayName ?? sv.name; const ud = sv.userData || {}; border = [ud.borderLeft ?? 0, ud.borderTop ?? 0, ud.borderRight ?? 0, ud.borderBottom ?? 0]; break; }
      }
      if (!frameName) { // 兜底: 第 N 帧(按 meta subMetas 顺序)或首帧
        const names = Object.keys(frames);
        frameName = names[0] ?? null;
        if (frameName) entry.note = `subMeta[${sub}] 未命中, 兜底首帧 ${frameName}`;
      }
      const fr = frameName ? frames[frameName] : null;
      if (!fr) { entry.note = `plist 帧未找到: ${frameName ?? '(null)'}`; return; }
      entry.name = frameName;
      entry.sprite = {
        name: frameName,
        rect: { x: fr.frame.x, y: fr.frame.y, width: fr.frame.w, height: fr.frame.h },
        offset: fr.offset ?? { x: 0, y: 0 },
        originalSize: fr.sourceSize ?? { width: fr.frame.w, height: fr.frame.h },
        rotated: !!fr.rotated,
        capInsets: border,
      };
      entry.file = plist.fileRel;
      entry.exists = true;
      return;
    }
    if (img) {
      // 独立图片: 全部信息在 <img>.meta subMetas[f9941].userData
      const sv = img.meta.subMetas?.[SPRITE_FRAME_SUB];
      const ud = sv?.userData ?? {};
      const stem = path.basename(img.fileRel).replace(/\.(png|jpg|jpeg|webp)$/i, '');
      entry.name = sv?.displayName ?? stem;
      entry.sprite = {
        name: entry.name,
        rect: { x: 0, y: 0, width: ud.width ?? ud.rawWidth ?? 0, height: ud.height ?? ud.rawHeight ?? 0 },
        offset: { x: ud.offsetX ?? 0, y: ud.offsetY ?? 0 },
        originalSize: { width: ud.rawWidth ?? ud.width ?? 0, height: ud.rawHeight ?? ud.height ?? 0 },
        rotated: ud.rotated === true,
        capInsets: [ud.borderLeft ?? 0, ud.borderTop ?? 0, ud.borderRight ?? 0, ud.borderBottom ?? 0],
      };
      entry.textureUuid = base + '@' + TEXTURE_SUB;
      entry.file = img.fileRel;
      entry.exists = fs.existsSync(path.join(projectRoot, img.fileRel));
      return;
    }
    entry.note = 'spriteFrame 工程资产未定位(无 --project 或 meta 缺失)';
    return;
  }
  // 非图集帧: prefab / 字体 / 其他
  const hit = idx.others.get(base);
  if (!hit) { entry.kind = 'asset'; entry.note = '工程资产未定位'; return; }
  entry.kind = /\.prefab$/i.test(hit.fileRel) ? 'prefab' : 'asset';
  if (entry.kind === 'prefab') {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(projectRoot, hit.fileRel), 'utf8'));
      const pf = d.find(e => e && e.__type__ === 'cc.Prefab');
      entry.prefabName = pf?._name ?? null;
    } catch { entry.prefabName = null; }
  }
  entry.file = hit.fileRel;
  entry.exists = true;
}

// ---------- 值整形: 编辑器 JSON → IR 值编码 ----------
function shapeValue(v, location, depth = 0) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map((x, i) => shapeValue(x, `${location}[${i}]`, depth + 1));
  if (typeof v !== 'object') return v;
  if ('__uuid__' in v) {
    const idx = registerAsset(v.__uuid__, location);
    return { $asset: idx, uuid: v.__uuid__ };
  }
  if ('__id__' in v) {
    const target = byId[v.__id__];
    const out = { $inst: v.__id__ };
    // 旁注: 指向节点的引用(ScrollView._content / Button._target 等)带精确节点名
    if (target && target.__type__ === 'cc.Node') out.resolvedNodeName = target._name ?? null;
    return out;
  }
  if (v.__type__) {
    if (depth > 10) return { __type__: v.__type__, __note: '嵌套过深截断' };
    const out = { __type__: v.__type__ };
    for (const [k, val] of Object.entries(v)) {
      if (k === '__type__' || k === '__id__') continue;
      out[k] = shapeValue(val, `${location}.${k}`, depth + 1);
    }
    return out;
  }
  return v; // 普通对象
}

// ---------- 嵌套 prefab 展开 ----------
const _templateCache = new Map();
/** 物化一个 .prefab 文件(工程内路径)的根节点子树(仅静态合并, 不处理 overrides)。 */
function loadTemplate(prefabUuid, location, depth) {
  if (_templateCache.has(prefabUuid)) return _templateCache.get(prefabUuid);
  const idx = assetIndex();
  const hit = idx.others.get(BASE_UUID(prefabUuid));
  if (!hit || !/\.prefab$/i.test(hit.fileRel)) { fail(location, `嵌套 prefab ${prefabUuid} 未定位`, 'nested-prefab'); return null; }
  let sub;
  try { sub = JSON.parse(fs.readFileSync(path.join(projectRoot, hit.fileRel), 'utf8')); }
  catch (e) { fail(location, `嵌套 prefab 读取失败: ${e.message}`, 'nested-prefab'); return null; }
  const pf = sub.find(e => e && e.__type__ === 'cc.Prefab');
  const rootRef = pf?.data;
  const rootNode = inst(rootRef);
  if (!rootNode || rootNode.__type__ !== 'cc.Node') { fail(location, `嵌套 prefab ${hit.fileRel} 根节点异常`, 'nested-prefab'); return null; }
  const tree = materialize(rootNode, `${location}@${prefabUuid}`, depth + 1, new Set(), sub);
  _templateCache.set(prefabUuid, tree);
  return tree;
}

// ---------- 节点物化 ----------
function materialize(nodeObj, location, depth, visited, subDoc = doc) {
  if (!nodeObj || nodeObj.__type__ !== 'cc.Node') { fail(location, `期望 cc.Node, 实为 ${nodeObj?.__type__}`, 'other'); return null; }
  if (visited.has(nodeObj)) { fail(location, '节点环引用', 'other'); return null; }
  visited.add(nodeObj);
  const node = {
    name: typeof nodeObj._name === 'string' ? nodeObj._name : '(unnamed)',
    active: nodeObj._active !== false,
    layer: nodeObj._layer ?? null,
    position: shapeValue(nodeObj._lpos, `${location}.lpos`),
    scale: shapeValue(nodeObj._lscale, `${location}.lscale`),
    rotation: shapeValue(nodeObj._lrot, `${location}.lrot`),
    fileId: null,
    mountedFrom: nodeObj.__mountedFrom ?? null,
    components: [],
    customScripts: [],
    children: [],
  };
  stats.nodes++;
  const pi = inst(nodeObj._prefab);
  if (pi && pi.__type__ === 'cc.PrefabInfo') {
    node.fileId = pi.fileId ?? null;
    if (Array.isArray(pi.targetOverrides) && pi.targetOverrides.length) {
      node.targetOverrides = pi.targetOverrides.map((t, i) => shapeValue(t, `${location}.targetOverrides[${i}]`, 1));
    }
    // 嵌套实例: PrefabInfo.asset 为外部 uuid → 展开源 prefab 子树挂载
    const assetRef = pi.asset;
    const nestedUuid = assetRef && typeof assetRef === 'object' && '__uuid__' in assetRef ? assetRef.__uuid__ : null;
    if (nestedUuid && expandOn && depth < maxNestDepth) {
      stats.nestedPrefabs++;
      const tpl = loadTemplate(nestedUuid, location, depth);
      if (tpl) {
        const merged = structuredClone(tpl);
        stampMounted(merged, { prefab: nestedUuid, fileId: node.fileId, instanceFileId: null });
        // 挂载点覆盖: 实例节点自身的 active/name/组件优先(仅 active/name; 组件级覆盖 v1 不处理)
        merged.name = node.name !== '(unnamed)' ? node.name : merged.name;
        merged.active = nodeObj._active !== false;
        for (const ch of (nodeObj._children || [])) {
          const childObj = inst(ch);
          if (childObj && childObj.__type__ === 'cc.Node') {
            // 实例自带的覆盖子节点(非源 prefab 内容) → 追加
            if (!childObj._prefab || !inst(childObj._prefab)?.asset?.__uuid__) {
              const extra = materialize(childObj, `${location}.children`, depth + 1, new Set([nodeObj]), subDoc);
              if (extra) merged.children.push(extra);
            }
          }
        }
        node._expanded = merged;
        return node; // 展开结果由调用方以 _expanded 替换
      }
    } else if (nestedUuid && !expandOn) {
      stats.nestedPrefabs++;
    } else if (nestedUuid) {
      fail(location, `嵌套深度超限(${depth})`, 'nested-prefab');
    }
  }
  const comps = Array.isArray(nodeObj._components) ? nodeObj._components : [];
  comps.forEach((cref, i) => {
    const comp = inst(cref);
    if (!comp || typeof comp !== 'object') return;
    if (comp.__type__ === 'cc.CompPrefabInfo') return;
    addComponent(node, comp, `${location}.components[${i}]`);
  });
  const kids = Array.isArray(nodeObj._children) ? nodeObj._children : [];
  for (const [i, cref] of kids.entries()) {
    const childObj = inst(cref);
    const child = childObj ? materialize(childObj, `${location}.children[${i}]`, depth + 1, new Set(visited), subDoc) : null;
    if (!child) continue;
    if (child._expanded) node.children.push(child._expanded);
    else node.children.push(child);
  }
  return node;
}
function stampMounted(n, m) {
  n.mountedFrom = m;
  for (const ch of n.children || []) stampMounted(ch, m);
}
function addComponent(node, comp, location) {
  const type = comp.__type__;
  const props = {};
  for (const [k, v] of Object.entries(comp)) {
    if (['__type__', '_name', '_objFlags', 'node', '_enabled', '__prefab', '_id', '_visFlags'].includes(k)) continue;
    props[k] = shapeValue(v, `${location}.${k}`);
  }
  const cpi = inst(comp.__prefab);
  const fileId = cpi && cpi.__type__ === 'cc.CompPrefabInfo' ? (cpi.fileId ?? null) : null;
  if (isScriptClass(type)) {
    node.customScripts.push({ uuid: type, fileId, props });
    stats.customScripts[type] = (stats.customScripts[type] || 0) + 1;
  } else {
    node.components.push({ type, fileId, props });
    stats.components[type] = (stats.components[type] || 0) + 1;
  }
  if (props._spriteFrame !== undefined && props._spriteFrame !== null) stats.spriteRefs++;
}

// ---------- 根选择 ----------
let rootNode = null, prefabName = null;
const prefabEntry = doc.find(e => e && e.__type__ === 'cc.Prefab');
const sceneAsset = doc.find(e => e && e.__type__ === 'cc.SceneAsset');
if (prefabEntry) {
  rootNode = inst(prefabEntry.data);
  prefabName = prefabEntry._name ?? null;
} else if (sceneAsset) {
  const scene = doc.find(e => e && e.__type__ === 'cc.Scene');
  const canvasNode = (scene?._children || []).map(inst).find(n => (n?._components || []).map(inst).some(c => c?.__type__ === 'cc.Canvas'));
  rootNode = canvasNode || (scene?._children || []).map(inst)[0] || null;
  prefabName = sceneAsset._name ?? null;
} else {
  rootNode = doc.find(e => e && e.__type__ === 'cc.Node') || null;
}
if (!rootNode) { console.error('未找到根节点(cc.Prefab/cc.SceneAsset/cc.Node): ' + inFile); process.exit(1); }

const irTree = materialize(rootNode, 'root', 0, new Set());
if (!irTree) { console.error('根物化失败'); process.exit(1); }

// spriteResolved 统计
(function countResolved(n) {
  for (const c of [...n.components, ...n.customScripts]) {
    const sf = c.props?._spriteFrame;
    if (sf && typeof sf === 'object' && sf.$asset !== undefined) {
      const a = assets[sf.$asset];
      if (a?.kind === 'spriteFrame' && a.exists && a.file) stats.spriteResolved++;
    }
  }
  for (const ch of n.children) countResolved(ch);
})(irTree);

// designResolution: 根 UITransform 内容尺寸
const rootUt = (irTree.components || []).find(c => c.type === 'cc.UITransform');
const cs = rootUt?.props?._contentSize;
const designResolution = cs ? { width: cs.width, height: cs.height } : { width: 750, height: 1334 };

// bundle: 默认 = 相对 assets/ 的一级目录
const relToAssets = path.relative(path.join(projectRoot ?? path.dirname(inFile), 'assets'), inFile).split(path.sep).join('/');
const defaultBundle = relToAssets.includes('/') ? relToAssets.split('/')[0] : (projectRoot ? 'assets' : path.basename(path.dirname(inFile)));
const bundle = argOf('--bundle') ?? defaultBundle;
const relSource = projectRoot ? path.relative(projectRoot, inFile).split(path.sep).join('/') : path.basename(inFile);

const ir = {
  meta: {
    bundle,
    source: relSource,
    sourceAbs: inFile.split(path.sep).join('/'),
    sourceUuid: null, // 编辑器文件无资产库 uuid(在 .meta 里, 非必需)
    prefabName,
    sectionIndex: 0,
    designResolution,
    stats,
    warnings: [],
  },
  assets,
  nodes: [irTree],
  unresolved,
};
if (projectRoot) ir.meta.projectRoot = projectRoot.split(path.sep).join('/');

if (outFile) {
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(path.resolve(outFile), JSON.stringify(ir, null, 1));
  console.log(`OK ${outFile}: nodes=${stats.nodes} comps=${Object.values(stats.components).reduce((a, b) => a + b, 0)} assets=${assets.length} nested=${stats.nestedPrefabs} unresolved=${unresolved.length}`);
} else {
  console.log(JSON.stringify({ meta: ir.meta, unresolved }, null, 1));
}
