#!/usr/bin/env node
/**
 * parse-prefab.mjs — Cocos Creator 3.8.x 压缩序列化(compiled JSON) prefab 反序列化器 → 结构化 IR
 *
 * 格式语义(实证 + 引擎源码 cocos-engine v3.8.8 cocos/serialization/deserialize.ts):
 *   顶层: [version, sharedUuids, sharedStrings, sharedClasses, sharedMasks, ...]
 *   - 普通 import 文件长度恒为 11: j[5..10] = [Instances, InstanceTypes, Refs, DependObjs, DependKeys, DependUuidIndices]
 *   - pack 文件长度恒为 6: j[5] = [section, section, ...] 每 section 6 元素同上;
 *     section 顺序 == config.json packs[packId] 的 uuid 索引顺序
 *   IClass = [类名/22位压缩uuid, [字段名...], offsetVal, ...类型ID]; 字段k类型 = clazz[k+offsetVal](仅高级字段)
 *   IMask  = [classIdx, 字段索引..., 高级区起始位(mask 内下标)]
 *   实例引用(InstanceRef): v>=0 → Instances[v] 绝对下标;
 *                          v<0  → Refs 槽位 slot=-v-1, 真实目标 = Instances[Refs[slot*3+2]] (绝对下标)
 *   值类型: [0]Vec2 [1]Vec3 [2]Vec4 [3]Quat [4]Color(uint32) [5]Size [6]Rect [7]Mat4
 *   [0,"<id>"] 模式 = 内嵌 cc.CompPrefabInfo(mask0, fileId), 不是资产引用!
 *   资产引用(AssetRefByInnerObj): 值=depend 下标 k → uuid=sharedUuids[DependUuidIndices[k]]
 *   嵌套 prefab: Node._prefab(cc.PrefabInfo){instance:cc.PrefabInstance, asset:depend→prefab uuid}
 *     展开按引擎 createNodeWithPrefab/expandPrefabInstanceNode:
 *       引用 prefab 根子树嫁接到挂载节点 → mountedChildren → removedComponents
 *       → mountedComponents → propertyOverrides(fileId 目标表 + propertyPath 逐段赋值)
 *
 * 用法:
 *   node parse-prefab.mjs <import.json路径> [--out out.json] [--section N] [--max-nest-depth 4]
 *                        [--gamecaches <dir>] [--bundle <name>] [--no-expand]
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ------------------------------------------------------------------ 常量
const DT = {
  SimpleType: 0, InstanceRef: 1, Array_InstanceRef: 2, Array_AssetRefByInnerObj: 3,
  Class: 4, ValueTypeCreated: 5, AssetRefByInnerObj: 6, TRS: 7, ValueType: 8,
  Array_Class: 9, CustomizedClass: 10, Dict: 11, Array: 12,
};
const VT_CTORS = ['Vec2', 'Vec3', 'Vec4', 'Quat', 'Color', 'Size', 'Rect', 'Mat4'];
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_IDX = (() => { const m = {}; for (let i = 0; i < B64.length; i++) m[B64[i]] = i; return m; })();
const isScriptClass = (t) => typeof t === 'string' && !t.includes('.'); // 组件类型名无 '.' = 自定义脚本(22/23 位压缩 uuid 哈希类名)

// ------------------------------------------------------------------ uuid
/** 压缩 uuid(22字符, 可带 @子资产后缀) → 完整 uuid: 前 2 字符字面 hex + 后 20 个 base64 字符位打包 120bit = 30 hex。 */
export function decompressUuid(u) {
  if (typeof u !== 'string') return u;
  const at = u.indexOf('@');
  const base = at >= 0 ? u.slice(0, at) : u;
  const suffix = at >= 0 ? u.slice(at) : '';
  if (base.length !== 22 || base.includes('-')) return u;
  let bits = '';
  for (let i = 2; i < 22; i++) {
    const v = B64_IDX[base[i]];
    if (v === undefined) return u;
    bits += v.toString(2).padStart(6, '0');
  }
  let hex = base.slice(0, 2);
  for (let i = 0; i < 120; i += 8) hex += parseInt(bits.slice(i, i + 8), 2).toString(16).padStart(2, '0');
  const full = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  return at >= 0 ? full + suffix : full;
}
export const baseUuid = (u) => (typeof u === 'string' && u.includes('@') ? u.slice(0, u.indexOf('@')) : u);

// ------------------------------------------------------------------ GameCaches
/** gamecaches 根目录: 各 bundle config/版本哈希/pack/import/native 定位。 */
export class GameCaches {
  constructor(root) {
    this.root = path.resolve(root);
    this._bundles = new Map();
    this._pinned = new Map(); // bundle -> ts(以 CLI 输入文件所在目录为准)
    this._names = null;
  }
  pin(bundle, ts) { this._pinned.set(bundle, ts); }
  bundleNames() {
    if (!this._names) this._names = fs.readdirSync(this.root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    return this._names;
  }
  bundle(name) {
    if (this._bundles.has(name)) return this._bundles.get(name);
    const dir = path.join(this.root, name);
    if (!fs.existsSync(dir)) return null;
    // config json(顶层 *.json) 与 res 目录(<ts>/res) 的时间戳可能不同, 分别探测
    const cfgFiles = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.json')).map(e => e.name);
    const resDirs = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'res'))).map(e => e.name);
    if (!cfgFiles.length || !resDirs.length) return null;
    resDirs.sort();
    const pinned = this._pinned.get(name);
    const ts = pinned && resDirs.includes(pinned) ? pinned : resDirs[resDirs.length - 1];
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, cfgFiles[0]), 'utf8'));
    const impHash = new Map(), natHash = new Map();
    const vi = cfg.versions?.import || [], vn = cfg.versions?.native || [];
    for (let i = 0; i + 1 < vi.length; i += 2) impHash.set(vi[i], vi[i + 1]);
    for (let i = 0; i + 1 < vn.length; i += 2) natHash.set(vn[i], vn[i + 1]);
    const packOf = new Map();
    for (const [pid, idxs] of Object.entries(cfg.packs || {})) idxs.forEach((ui, pos) => packOf.set(ui, { packUuid: pid, pos }));
    const b = { name, ts, resDir: path.join(dir, ts, 'res'), config: cfg, impHash, natHash, packOf, packCache: new Map(), decCache: new Map() };
    this._bundles.set(name, b);
    return b;
  }
  /** uuid → {bundle, idx, kind, file, section?} */
  locate(uuid, hintBundle) {
    if (typeof uuid !== 'string') return null;
    const order = hintBundle ? [hintBundle, ...this.bundleNames().filter(n => n !== hintBundle)] : this.bundleNames();
    for (const bn of order) {
      const b = this.bundle(bn);
      if (!b) continue;
      const idx = (b.config.uuids || []).indexOf(uuid);
      if (idx < 0) continue;
      const pack = b.packOf.get(idx);
      if (pack) {
        const pIdx = (b.config.uuids || []).indexOf(pack.packUuid);
        const hash = b.impHash.get(pIdx);
        const file = path.join(b.resDir, b.config.importBase || 'import', pack.packUuid.slice(0, 2), `${pack.packUuid}.${hash}.json`);
        return { bundle: bn, idx, kind: 'pack', file, section: pack.pos };
      }
      const hash = b.impHash.get(idx);
      if (!hash) continue;
      const full = decompressUuid(uuid);
      const file = path.join(b.resDir, b.config.importBase || 'import', full.slice(0, 2), `${full}.${hash}.json`);
      return { bundle: bn, idx, kind: 'import', file };
    }
    return null;
  }
  /** uuid → 解码文档(含 rootType/deps/kind)。返回 {dec, loc}。 */
  loadDecoded(uuid, hintBundle) {
    const loc = this.locate(uuid, hintBundle);
    if (!loc || !fs.existsSync(loc.file)) return null;
    const b = this.bundle(loc.bundle);
    const key = `${loc.file}#${loc.section ?? 0}`;
    if (!b.decCache.has(key)) {
      let doc;
      if (loc.kind === 'pack') {
        if (!b.packCache.has(loc.file)) b.packCache.set(loc.file, JSON.parse(fs.readFileSync(loc.file, 'utf8')));
        doc = sectionToDoc(b.packCache.get(loc.file), loc.section);
      } else doc = fileToDoc(loc.file);
      const dec = decodeSection(doc);
      const rootInst = dec.instances[dec.rootIndex];
      let rootType = rootInst?.__type__ ?? null, kind = 'asset';
      if (rootInst?.__custom) { rootType = rootInst.__type__; kind = rootType === 'cc.SpriteFrame' ? 'spriteFrame' : rootType; }
      else if (rootType === 'cc.Prefab') kind = 'prefab';
      else if (rootType === 'cc.Node') kind = 'node';
      else if (rootType === 'cc.ImageAsset') kind = 'image';
      b.decCache.set(key, { dec, rootType, kind, content: rootInst?.__custom ? rootInst.content : null, loc });
    }
    return b.decCache.get(key);
  }
  /** base uuid → native 贴图文件路径(按扩展名探测: 缓存里 png/jpg/webp 并存)。 */
  nativePath(uuid, hintBundle) {
    const base = baseUuid(uuid);
    const order = hintBundle ? [hintBundle, ...this.bundleNames().filter(n => n !== hintBundle)] : this.bundleNames();
    for (const bn of order) {
      const b = this.bundle(bn);
      if (!b) continue;
      const idx = (b.config.uuids || []).indexOf(base);
      if (idx < 0) continue;
      const hash = b.natHash.get(idx);
      if (!hash) continue;
      const full = decompressUuid(base);
      const dir = path.join(b.resDir, b.config.nativeBase || 'native', full.slice(0, 2));
      const stem = `${full}.${hash}`;
      for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
        const f = path.join(dir, stem + ext);
        if (fs.existsSync(f)) return f;
      }
      return path.join(dir, stem + '.png'); // 未命中, 返回 png 路径由调用方标记
    }
    return null;
  }
  assetName(uuid, hintBundle) {
    const loc = this.locate(uuid, hintBundle);
    if (!loc) return null;
    const p = this.bundle(loc.bundle).config.paths?.[String(loc.idx)];
    return p ? p[0] : null;
  }
}

function fileToDoc(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (j.length === 6 && Array.isArray(j[5]) && Array.isArray(j[5][0])) return sectionToDoc(j, 0);
  return { sharedUuids: j[1] || [], sharedStrings: j[2] || [], sharedClasses: j[3] || [], sharedMasks: j[4] || [], section: j.slice(5) };
}
function sectionToDoc(pack, si) {
  const sec = pack[5][si];
  return { sharedUuids: pack[1] || [], sharedStrings: pack[2] || [], sharedClasses: pack[3] || [], sharedMasks: pack[4] || [], section: sec };
}

// ------------------------------------------------------------------ section 解码
export function decodeSection(doc) {
  const strings = doc.sharedStrings || [];
  const classes = doc.sharedClasses || [];
  const masks = doc.sharedMasks || [];
  const [rawInst, instTypesRaw, refsRaw, depObjs, depKeys, depUuids] = doc.section;
  const instTypes = instTypesRaw === 0 ? [] : instTypesRaw;
  const refs = refsRaw === 0 ? null : refsRaw;
  const warnings = [];

  const deps = (depObjs || []).map((_, i) => ({
    owner: typeof depObjs[i] === 'number' ? depObjs[i] : null,
    key: typeof depKeys?.[i] === 'number' ? (depKeys[i] >= 0 ? strings[depKeys[i]] ?? `s${depKeys[i]}` : `#${~depKeys[i]}`) : (depKeys?.[i] ?? null),
    uuid: typeof depUuids?.[i] === 'number' ? (doc.sharedUuids?.[depUuids[i]] ?? `u${depUuids[i]}`) : (depUuids?.[i] ?? null),
  }));

  let rootIndex = 0, hasRootInfo = false, hasNativeDep = false;
  const last = rawInst[rawInst.length - 1];
  if (typeof last === 'number') { rootIndex = last < 0 ? ~last : last; hasRootInfo = true; hasNativeDep = last < 0; }
  const normalCount = rawInst.length - instTypes.length - (hasRootInfo ? 1 : 0);

  const ctx = { strings, classes, masks, refs, deps, warnings };
  const instances = new Array(rawInst.length - (hasRootInfo ? 1 : 0));
  for (let i = 0; i < normalCount; i++) instances[i] = expandClassObject(rawInst[i], ctx);
  for (let t = 0; t < instTypes.length; t++) {
    const i = normalCount + t, type = instTypes[t], raw = rawInst[i];
    if (type >= 0) instances[i] = { __type__: classNameOf(classes[type]), __custom: true, content: raw };
    else instances[i] = expandValue(raw, ~type, ctx);
  }

  if (refs && refs.length) {
    const offsetSlots = refs[refs.length - 1];
    for (let i = offsetSlots * 3; i < refs.length - 1; i += 3) {
      const owner = refs[i], keyIdx = refs[i + 1], target = refs[i + 2];
      const ownerObj = instances[owner];
      if (!ownerObj || instances[target] === undefined) { warnings.push(`refs 三元组越界 [${owner},${keyIdx},${target}]`); continue; }
      if (keyIdx >= 0) ownerObj[strings[keyIdx]] = { $inst: target };
      else if (Array.isArray(ownerObj)) ownerObj[~keyIdx] = { $inst: target };
      else ownerObj[`#${~keyIdx}`] = { $inst: target };
    }
  }
  return { instances, rootIndex, deps, hasNativeDep, warnings };
}

const classNameOf = (cls) => (typeof cls === 'string' ? cls : cls[0]);

function expandClassObject(data, ctx) {
  if (data === null || typeof data !== 'object' || !Array.isArray(data) || typeof data[0] !== 'number') return data;
  const mask = ctx.masks[data[0]];
  if (!mask) { ctx.warnings.push(`未知 mask ${data[0]}`); return { __type__: '?', __bad: data }; }
  const cls = ctx.classes[mask[0]];
  const obj = { __type__: classNameOf(cls), __mask: data[0] };
  const keys = cls[1] || [];
  const offsetVal = cls[2];
  const entries = mask.slice(1, -1);
  const advAt = mask[mask.length - 1];
  for (let pos = 0; pos < entries.length; pos++) {
    const keyIdx = entries[pos];
    const key = keys[keyIdx] ?? `f${keyIdx}`;
    if (pos + 1 < advAt) obj[key] = data[pos + 1];
    else obj[key] = expandValue(data[pos + 1], cls[keyIdx + offsetVal], ctx);
  }
  return obj;
}

function valueType(tag, nums) {
  switch (tag) {
    case 0: return { __type__: 'cc.Vec2', x: nums[0], y: nums[1] };
    case 1: return { __type__: 'cc.Vec3', x: nums[0], y: nums[1], z: nums[2] };
    case 2: return { __type__: 'cc.Vec4', x: nums[0], y: nums[1], z: nums[2], w: nums[3] };
    case 3: return { __type__: 'cc.Quat', x: nums[0], y: nums[1], z: nums[2], w: nums[3] };
    case 4: { const u = nums[0] >>> 0; return { __type__: 'cc.Color', uint32: u, r: (u >>> 24) & 255, g: (u >>> 16) & 255, b: (u >>> 8) & 255, a: u & 255 }; }
    case 5: return { __type__: 'cc.Size', width: nums[0], height: nums[1] };
    case 6: return { __type__: 'cc.Rect', x: nums[0], y: nums[1], width: nums[2], height: nums[3] };
    case 7: return { __type__: 'cc.Mat4', m: nums.slice() };
    default: return { __type__: `cc.ValueType${tag}`, values: nums.slice() };
  }
}

function expandValue(v, typeId, ctx) {
  if (v === null || v === undefined) return v;
  switch (typeId) {
    case DT.SimpleType: return v;
    case DT.InstanceRef: {
      if (typeof v !== 'number') return v;
      if (v >= 0) return { $inst: v };
      if (!ctx.refs) { ctx.warnings.push(`负实例引用 ${v} 但无 Refs 表`); return { $inst: -1, __err: 'no-refs' }; }
      const target = ctx.refs[(-v - 1) * 3 + 2];
      if (typeof target !== 'number') { ctx.warnings.push(`Refs 槽 ${-v - 1} 无效`); return { $inst: -1, __err: 'bad-refs-slot' }; }
      return { $inst: target };
    }
    case DT.Class: return expandClassObject(v, ctx);
    case DT.ValueTypeCreated:
    case DT.ValueType: return Array.isArray(v) ? valueType(v[0], v.slice(1)) : v;
    case DT.AssetRefByInnerObj: return { __asset: v, uuid: ctx.deps[v]?.uuid ?? null };
    case DT.Array_InstanceRef: return Array.isArray(v) ? v.map(x => expandValue(x, DT.InstanceRef, ctx)) : v;
    case DT.Array_Class: return Array.isArray(v) ? v.map(x => expandValue(x, DT.Class, ctx)) : v;
    case DT.Array_AssetRefByInnerObj: return Array.isArray(v) ? v.map(x => expandValue(x, DT.AssetRefByInnerObj, ctx)) : v;
    case DT.Array: { // 通用数组 [items[], 每元素类型...]
      if (!Array.isArray(v)) return v;
      const items = v[0];
      return items.map((item, i) => expandValue(item, v[i + 1] ?? DT.SimpleType, ctx));
    }
    case DT.Dict: { // [plainObj, key, type, value, ...]
      if (!Array.isArray(v)) return v;
      const out = (v[0] && typeof v[0] === 'object' && !Array.isArray(v[0])) ? { ...v[0] } : {};
      for (let i = 1; i + 2 < v.length; i += 3) out[v[i]] = expandValue(v[i + 2], v[i + 1], ctx);
      return out;
    }
    case DT.CustomizedClass: {
      if (!Array.isArray(v)) return v;
      return { __type__: classNameOf(ctx.classes[v[0]]), __custom: true, content: v[1] };
    }
    case DT.TRS: return v;
    default: ctx.warnings.push(`未知 DataTypeID ${typeId}`); return v;
  }
}

// ------------------------------------------------------------------ IR 构建
const isMarker = (v) => v && typeof v === 'object' && !Array.isArray(v) && '$inst' in v;
const isAssetMark = (v) => v && typeof v === 'object' && !Array.isArray(v) && '__asset' in v;

class IRBuilder {
  constructor(opts) {
    this.gc = opts.gc;
    this.hintBundle = opts.bundle;
    this.unresolved = [];
    this.assets = [];
    this._assetByUuid = new Map();
    this.stats = { nodes: 0, components: {}, customScripts: {}, spriteRefs: 0, spriteResolved: 0, nestedPrefabs: 0, overridesApplied: 0 };
    this.maxNestDepth = opts.maxNestDepth ?? 4;
    this.expand = opts.expand !== false;
    this._templateCache = new Map(); // prefabUuid → 已物化(未展开挂载)根子树
    this.section = null;            // 当前 section: {instances, deps}
  }
  fail(location, reason, category = 'other') { this.unresolved.push({ location, reason, category }); }

  // ---------- 资产 ----------
  assetIndex(uuid, location) {
    if (!uuid) { this.fail(location, '资产 uuid 为空', 'asset'); return null; }
    if (this._assetByUuid.has(uuid)) return this._assetByUuid.get(uuid);
    const entry = { uuid, kind: 'unknown', name: null, file: null, exists: false };
    const idx = this.assets.push(entry) - 1;
    this._assetByUuid.set(uuid, idx);
    try { this.fillAsset(entry, uuid); } catch (e) { this.fail(location, `资产解析异常 ${uuid}: ${e.message}`, 'asset'); }
    return idx;
  }
  fillAsset(entry, uuid) {
    entry.name = this.gc.assetName(uuid, this.hintBundle);
    if (uuid.endsWith('@f9941')) {
      entry.kind = 'spriteFrame';
      const loaded = this.gc.loadDecoded(uuid, this.hintBundle);
      if (!loaded) { entry.note = 'spriteFrame import 未找到'; return; }
      const sf = loaded.content;
      if (sf && typeof sf === 'object' && sf.name !== undefined) {
        entry.sprite = { name: sf.name, rect: sf.rect, offset: sf.offset, originalSize: sf.originalSize, rotated: !!sf.rotated, capInsets: sf.capInsets };
      } else entry.note = 'spriteFrame 内容异常';
      const texDep = loaded.dec.deps.find(d => d.key === '_textureSource');
      if (!texDep?.uuid) { entry.note = (entry.note ? entry.note + '; ' : '') + '无 _textureSource 依赖'; return; }
      entry.textureUuid = baseUuid(texDep.uuid);
      const png = this.gc.nativePath(texDep.uuid, loaded.loc.bundle);
      if (!png) { entry.note = (entry.note ? entry.note + '; ' : '') + `纹理 ${texDep.uuid} 未找到 native png`; return; }
      entry.file = path.relative(this.gc.root, png).split(path.sep).join('/');
      entry.exists = fs.existsSync(png);
      return;
    }
    if (uuid.endsWith('@6c48a')) {
      entry.kind = 'texture';
      const png = this.gc.nativePath(uuid, this.hintBundle);
      if (!png) { entry.note = '未找到 native png'; return; }
      entry.file = path.relative(this.gc.root, png).split(path.sep).join('/');
      entry.exists = fs.existsSync(png);
      return;
    }
    const loaded = this.gc.loadDecoded(uuid, this.hintBundle);
    if (!loaded) { entry.kind = 'asset'; entry.note = 'import 未找到(可能跨包/已裁剪)'; return; }
    entry.kind = loaded.kind;
    if (loaded.kind === 'prefab') entry.prefabName = this.prefabNameOf(loaded);
    entry.file = path.relative(this.gc.root, loaded.loc.file).split(path.sep).join('/');
    entry.exists = fs.existsSync(loaded.loc.file);
  }
  prefabNameOf(loaded) {
    const root = loaded.dec.instances[loaded.dec.rootIndex];
    return root?._name ?? null;
  }

  // ---------- 值整形 ----------
  shapeValue(v, location, depth = 0) {
    if (v === null || v === undefined) return v;
    if (Array.isArray(v)) return v.map((x, i) => this.shapeValue(x, `${location}[${i}]`, depth + 1));
    if (typeof v !== 'object') return v;
    if (isAssetMark(v)) return { __asset: v.__asset, uuid: v.uuid ?? null };
    if (isMarker(v)) {
      if (v.$inst < 0) { this.fail(location, `实例引用解析失败 ${JSON.stringify(v)}`, 'instance-ref'); return null; }
      return { $inst: v.$inst };
    }
    if (v.__custom) return { __type__: v.__type__, content: this.shapeValue(v.content, `${location}.content`, depth + 1) };
    if (v.__type__) {
      if (v.__type__ === 'cc.CompPrefabInfo') return { __type__: 'cc.CompPrefabInfo', fileId: v.fileId };
      if (depth > 10) return { __type__: v.__type__, __note: '嵌套过深截断' };
      const out = { __type__: v.__type__ };
      for (const [k, val] of Object.entries(v)) {
        if (k === '__type__' || k === '__mask' || k === '__expanded' || k === '__mountedFrom') continue;
        out[k] = this.shapeValue(val, `${location}.${k}`, depth + 1);
      }
      return out;
    }
    return v; // SimpleType 普通对象
  }

  // ---------- 节点 ----------
  buildIRNode(nodeObj, location) {
    if (!nodeObj || nodeObj.__type__ !== 'cc.Node') { this.fail(location, `期望 cc.Node, 实为 ${nodeObj?.__type__}`, 'other'); return null; }
    const node = {
      name: typeof nodeObj._name === 'string' ? nodeObj._name : '(unnamed)',
      active: nodeObj._active !== false,
      layer: nodeObj._layer ?? null,
      position: this.shapeValue(nodeObj._lpos, `${location}.lpos`),
      scale: this.shapeValue(nodeObj._lscale, `${location}.lscale`),
      rotation: this.shapeValue(nodeObj._lrot, `${location}.lrot`),
      fileId: nodeObj._prefab?.fileId ?? null,
      mountedFrom: nodeObj.__mountedFrom ?? null,
      components: [],
      customScripts: [],
      children: [],
    };
    this.stats.nodes++;
    // PrefabInfo.targetOverrides(cc.TargetOverrideInfo): 组件引用目标重定向, 原样保留
    if (Array.isArray(nodeObj._prefab?.targetOverrides) && nodeObj._prefab.targetOverrides.length) {
      node.targetOverrides = nodeObj._prefab.targetOverrides.map((t, i) => this.shapeValue(t, `${location}.targetOverrides[${i}]`, 1));
    }
    const comps = Array.isArray(nodeObj._components) ? nodeObj._components : [];
    comps.forEach((cv, i) => {
      const comp = isMarker(cv) ? this.section.instances[cv.$inst] : cv;
      if (!comp || typeof comp !== 'object') return;
      if (comp.__type__ === 'cc.CompPrefabInfo') return;
      this.addComponent(node, comp, comp.__idx ?? null, `${location}.components[${i}]`);
    });
    return node;
  }
  addComponent(node, comp, compIdx, location) {
    const type = comp.__type__;
    const props = {};
    for (const [k, v] of Object.entries(comp)) {
      if (['__type__', '__mask', 'node', '__prefab', '__idx', '__expanded', '__mountedFrom'].includes(k)) continue;
      props[k] = this.shapeValue(v, `${location}.${k}`);
    }
    const fileId = comp.__prefab?.fileId ?? null;
    // 提升(hoisted)到顶层的组件经 depend 表回填资产引用: owner=该组件实例下标, key 不在 mask 字段中
    if (compIdx !== null && this.section.deps) {
      for (const [di, d] of this.section.deps.entries()) {
        if (d.owner === compIdx && d.uuid && !(d.key in props) && !String(d.key).startsWith('#')) {
          props[d.key] = { $asset: this.assetIndex(d.uuid, `${location}.deps[${di}]`), uuid: d.uuid, viaDep: true };
        }
      }
    }
    if (isScriptClass(type)) {
      node.customScripts.push({ uuid: type, fileId, props });
      this.stats.customScripts[type] = (this.stats.customScripts[type] || 0) + 1;
    } else {
      node.components.push({ type, fileId, props });
      this.stats.components[type] = (this.stats.components[type] || 0) + 1;
    }
    if (props._spriteFrame !== undefined && props._spriteFrame !== null) this.stats.spriteRefs++;
  }

  /** remap 之后统计 sprite 引用解析率(走最终 IR 树, 只统计 _spriteFrame 字段)。 */
  countSpriteResolution(node) {
    for (const c of [...node.components, ...node.customScripts]) {
      const sf = c.props?._spriteFrame;
      if (sf && typeof sf === 'object' && (sf.$asset !== undefined || sf.__asset !== undefined)) {
        const a = this.assets[sf.$asset];
        if (a?.kind === 'spriteFrame' && a.exists && a.file) this.stats.spriteResolved++;
      }
    }
    for (const ch of node.children) this.countSpriteResolution(ch);
  }

  // ---------- 嵌套 prefab(引擎 expandPrefabInstanceNode) ----------
  expandNode(nodeObj, location, depth) {
    if (!this.expand || !nodeObj || nodeObj.__type__ !== 'cc.Node') return nodeObj;
    if (nodeObj.__expanded) return nodeObj;
    const pi = nodeObj._prefab;
    const pInst = pi?.instance;
    if (!pInst || pInst.__type__ !== 'cc.PrefabInstance') return nodeObj;
    if (depth > this.maxNestDepth) { this.fail(location, `嵌套深度超限(${depth})`, 'nested-prefab'); return nodeObj; }

    let prefabUuid = isAssetMark(pi.asset) ? pi.asset.uuid : (pi.asset?.uuid ?? null);
    if (!prefabUuid) { this.fail(location, `挂载节点 ${nodeObj._name ?? '?'} _prefab.asset 未解析`, 'nested-prefab'); return nodeObj; }

    let template = this._templateCache.get(prefabUuid);
    if (!template) {
      const loaded = this.gc.loadDecoded(prefabUuid, this.hintBundle);
      if (!loaded || loaded.kind !== 'prefab') { this.fail(location, `嵌套 prefab ${prefabUuid} 加载失败`, 'nested-prefab'); return nodeObj; }
      const save = this.section;
      this.section = { instances: loaded.dec.instances, deps: loaded.dec.deps };
      template = this.materializeRoot(loaded.dec, `${location}@${prefabUuid}`);
      if (template) {
        // 引擎语义: 嵌套 prefab 应在父级覆盖之前展开 —— 模板内自身的挂载在其自己的 section 上下文中先行展开
        this.expandAllMounts(template, `${location}@${prefabUuid}`, depth + 1);
      }
      this.section = save;
      if (!template) { this.fail(location, `嵌套 prefab ${prefabUuid} 无根节点`, 'nested-prefab'); return nodeObj; }
      this._templateCache.set(prefabUuid, template);
    }
    const grafted = cloneDecoded(template);
    grafted.__mountedFrom = { prefab: prefabUuid, fileId: pi.fileId ?? null, instanceFileId: pInst.fileId ?? null };
    grafted.__expanded = true;
    // 引擎 createNodeWithPrefab: 嫁接后保留 outer PrefabInstance 引用(node.prefab.instance = prefabInfo.instance)
    if (grafted._prefab) {
      grafted._prefab = { ...grafted._prefab };
      grafted._prefab.instance = pInst;
    } else grafted._prefab = { fileId: pi.fileId ?? null, instance: pInst };
    this.stats.nestedPrefabs++;

    // 嵌套 fileId 目标表(引擎 generateTargetMap: 根不建子表; 子级带 PrefabInstance 的挂子树单开子表)
    const targetMap = new Map();
    const buildMap = (n, m, isRoot) => {
      let cur = m;
      const inst = n._prefab?.instance;
      if (!isRoot && inst && inst.__type__ === 'cc.PrefabInstance') {
        cur = new Map();
        m.set(inst.fileId, cur);
      }
      if (n._prefab?.fileId) cur.set(n._prefab.fileId, n);
      for (const c of n._components || []) {
        const cc = isMarker(c) ? this.section.instances[c.$inst] : c;
        if (cc?.__prefab?.fileId) cur.set(cc.__prefab.fileId, cc);
      }
      for (const ch of n._children || []) buildMap(ch, cur, false);
    };
    buildMap(grafted, targetMap, true);
    const getTarget = (localID) => {
      if (!Array.isArray(localID)) return null;
      let t = null;
      let m = targetMap;
      for (const seg of localID) {
        if (!m || !(m instanceof Map)) return null;
        t = m.get(seg) ?? null;
        if (!t) return null;
        m = (t instanceof Map) ? t : null;
      }
      return (t instanceof Map) ? null : t;
    };

    // targetInfo 可能是内嵌 cc.TargetInfo 对象, 也可能是对顶层 TargetInfo 实例的 InstanceRef
    const ti = (t) => (t && isMarker(t)) ? this.section.instances[t.$inst] : t;

    for (const mc of pInst.mountedChildren || []) {
      const target = getTarget(ti(mc?.targetInfo)?.localID);
      if (!target) { this.fail(location, `mountedChildren 目标未找到 ${JSON.stringify(ti(mc?.targetInfo)?.localID)}`, 'nested-prefab'); continue; }
      for (const nm of mc.nodes || []) {
        const nObj = isMarker(nm) ? this.section.instances[nm.$inst] : nm;
        if (!nObj || nObj.__type__ !== 'cc.Node') { this.fail(location, 'mountedChildren 节点无效', 'instance-ref'); continue; }
        this.materialize(nObj, `${location}.mounted`, new Set()); // 挂载子树标记物化(当前 section 上下文)
        target._children = target._children || [];
        if (!target._children.includes(nObj)) target._children.push(nObj);
      }
    }
    for (const rc of pInst.removedComponents || []) {
      const target = getTarget(ti(rc)?.localID);
      if (!target?._components) continue;
      const i = target._components.indexOf(target);
      if (i >= 0) target._components.splice(i, 1);
    }
    for (const mc of pInst.mountedComponents || []) {
      const target = getTarget(ti(mc?.targetInfo)?.localID);
      if (!target) { this.fail(location, `mountedComponents 目标未找到 ${JSON.stringify(ti(mc?.targetInfo)?.localID)}`, 'nested-prefab'); continue; }
      for (const cm of mc.components || []) {
        const cObj = isMarker(cm) ? this.section.instances[cm.$inst] : cm;
        if (cObj && typeof cObj === 'object') {
          cObj.node = target;
          target._components = target._components || [];
          target._components.push(cObj);
        }
      }
    }
    for (const po of pInst.propertyOverrides || []) {
      const target = getTarget(ti(po?.targetInfo)?.localID);
      if (!target) { this.fail(location, `propertyOverride 目标未找到 ${JSON.stringify(ti(po?.targetInfo)?.localID)} path=${JSON.stringify(po?.propertyPath)}`, 'nested-prefab'); continue; }
      const pp = [...(po.propertyPath || [])];
      if (!pp.length) continue;
      const lastKey = pp.pop();
      let owner = target;
      for (const seg of pp) { if (owner == null) break; owner = Array.isArray(owner) ? owner[Number(seg)] : owner[seg]; }
      if (owner == null) { this.fail(location, `propertyOverride 路径中断 ${JSON.stringify(po.propertyPath)}`, 'nested-prefab'); continue; }
      if (Array.isArray(owner)) owner[Number(lastKey)] = po.value;
      else owner[lastKey] = po.value;
      this.stats.overridesApplied++;
    }
    // 原地改写挂载节点(父级 _children 数组引用不变, 目标表/后续遍历才能看到嫁接后的子树)
    const keys = Object.keys(nodeObj);
    for (const k of keys) delete nodeObj[k];
    Object.assign(nodeObj, grafted);
    return nodeObj;
  }

  /** 在当前 section 上下文里递归展开子树中的全部挂载节点(用于模板预展开)。 */
  expandAllMounts(nodeObj, location, depth) {
    this.expandNode(nodeObj, location, depth); // expandNode 原地改写挂载节点
    for (const [i, c] of (nodeObj._children || []).entries()) this.expandAllMounts(c, `${location}.children[${i}]`, depth);
    return nodeObj;
  }

  /** 物化根节点(标记→对象)。 */
  materializeRoot(dec, location) {
    const rootObj = dec.instances[dec.rootIndex];
    const rootNode = rootObj?.__type__ === 'cc.Prefab'
      ? (isMarker(rootObj.data) ? dec.instances[rootObj.data.$inst] : rootObj.data)
      : rootObj;
    if (!rootNode || rootNode.__type__ !== 'cc.Node') return null;
    return this.materialize(rootNode, location, new Set());
  }
  materialize(nodeObj, location, seen) {
    if (!nodeObj || typeof nodeObj !== 'object' || nodeObj.__type__ !== 'cc.Node' || seen.has(nodeObj)) return nodeObj;
    seen.add(nodeObj);
    if (Array.isArray(nodeObj._children)) {
      nodeObj._children = nodeObj._children.map((c, i) => {
        if (c === null || c === undefined) return null;
        const obj = isMarker(c) ? this.section.instances[c.$inst] : c;
        if (!obj) { this.fail(`${location}.children[${i}]`, `子实例 #${c?.$inst} 缺失`, 'instance-ref'); return null; }
        if (obj.__type__ !== 'cc.Node') { this.fail(`${location}.children[${i}]`, `子实例非节点: ${obj.__type__}`, 'other'); return null; }
        return obj;
      }).filter(Boolean);
      nodeObj._children.forEach((c, i) => this.materialize(c, `${location}.children[${i}]`, seen));
    } else nodeObj._children = [];
    if (Array.isArray(nodeObj._components)) {
      nodeObj._components = nodeObj._components.map(cv => {
        if (cv === null || cv === undefined) return null;
        if (isMarker(cv)) {
          const obj = this.section.instances[cv.$inst];
          if (!obj) { this.fail(`${location}.components`, `组件实例 #${cv.$inst} 缺失`, 'instance-ref'); return null; }
          if (obj.__idx === undefined) obj.__idx = cv.$inst; // 记录实例下标(依赖表回填用)
          return obj;
        }
        return cv;
      }).filter(c => c && typeof c === 'object' && c.__type__ !== 'cc.CompPrefabInfo');
    } else nodeObj._components = [];
    return nodeObj;
  }

  irTree(nodeObj, location) {
    this.expandNode(nodeObj, location, 0); // 原地展开(若有挂载)
    const node = this.buildIRNode(nodeObj, location);
    if (!node) return null;
    (nodeObj._children || []).forEach((c, i) => {
      const child = this.irTree(c, `${location}.children[${i}]`);
      if (child) node.children.push(child);
    });
    return node;
  }
}

function cloneDecoded(o, map = new Map()) {
  if (Array.isArray(o)) return o.map(x => cloneDecoded(x, map));
  if (o && typeof o === 'object') {
    if (map.has(o)) return map.get(o);
    const out = {};
    map.set(o, out);
    for (const [k, v] of Object.entries(o)) out[k] = cloneDecoded(v, map);
    return out;
  }
  return o;
}

// ------------------------------------------------------------------ 入口
export function inferGamecachesRoot(abs) {
  const parts = path.resolve(abs).split(/[\\/]/);
  const i = parts.lastIndexOf('import');
  if (i >= 5) return parts.slice(0, i - 3).join('/'); // [..., gamecaches, bundle, ts, res, import]
  throw new Error(`无法从路径推断 gamecaches 根: ${abs}`);
}
export function inferBundleAndTs(abs) {
  const parts = path.resolve(abs).split(/[\\/]/);
  const i = parts.lastIndexOf('gamecaches');
  return i >= 0 ? { bundle: parts[i + 1], ts: parts[i + 2] } : { bundle: null, ts: null };
}

/** 解析 import json(或 pack) → IR。 */
export function parsePrefabFile(file, opts = {}) {
  const abs = path.resolve(file);
  const gc = opts.gc ?? new GameCaches(opts.gamecaches ?? inferGamecachesRoot(abs));
  const { bundle: inferred, ts } = inferBundleAndTs(abs);
  if (inferred && ts) gc.pin(inferred, ts);
  const bundle = opts.bundle ?? inferred;

  const j = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const isPack = j.length === 6 && Array.isArray(j[5]) && Array.isArray(j[5][0]);
  const sections = [];
  if (isPack) j[5].forEach((_, si) => sections.push({ doc: sectionToDoc(j, si), si }));
  else sections.push({ doc: fileToDoc(abs), si: 0 });

  const decoded = sections.map(s => {
    const dec = decodeSection(s.doc);
    const rootInst = dec.instances[dec.rootIndex];
    return { ...s, dec, rootInst, rootType: rootInst?.__type__ ?? null, rootCustom: !!rootInst?.__custom };
  });
  const wanted = opts.section != null ? decoded[opts.section]
    : decoded.find(d => d.rootType === 'cc.Prefab') || decoded.find(d => d.rootType === 'cc.Node') || decoded[0];
  if (!wanted) throw new Error('无可解码 section');

  const builder = new IRBuilder({ gc, bundle: wanted.loc?.bundle ?? bundle, maxNestDepth: opts.maxNestDepth ?? 4, expand: opts.expand !== false });
  builder.section = { instances: wanted.dec.instances, deps: wanted.dec.deps };
  const materialized = builder.materializeRoot(wanted.dec, 'root');
  if (!materialized) throw new Error(`根不是 cc.Node: ${wanted.rootType}`);
  const tree = builder.irTree(materialized, 'root');

  // 资产标记重映射: {__asset:k, uuid} → {$asset:全局索引, uuid} (按 uuid 归集, 跨 section 安全)
  const remap = new Map();
  for (const [di, d] of wanted.dec.deps.entries()) if (d.uuid) remap.set(di, builder.assetIndex(d.uuid, `deps[${di}]`));
  const remapMarkers = (v, loc) => {
    if (Array.isArray(v)) { v.forEach((x, i) => remapMarkers(x, loc)); return; }
    if (v && typeof v === 'object' && isAssetMark(v)) {
      if (v.uuid) v.$asset = builder.assetIndex(v.uuid, loc);
      else {
        const gi = remap.get(v.__asset);
        if (gi === undefined) { builder.fail(loc, `依赖下标 ${v.__asset} 无 uuid`, 'asset'); v.$asset = null; }
        else v.$asset = gi;
        v.uuid = builder.assets[v.$asset]?.uuid ?? null;
      }
      delete v.__asset;
      return;
    }
    if (v && typeof v === 'object' && !isMarker(v)) for (const [k, val] of Object.entries(v)) if (k !== '$asset' && k !== 'uuid') remapMarkers(val, `${loc}.${k}`);
  };
  remapMarkers(tree, 'nodes');
  builder.countSpriteResolution(tree);

  const rootUITransform = tree.components.find(c => c.type === 'cc.UITransform');
  const designResolution = rootUITransform?.props?._contentSize
    ? { width: rootUITransform.props._contentSize.width, height: rootUITransform.props._contentSize.height }
    : { width: 750, height: 1334 };

  const rel = path.relative(gc.root, abs).split(path.sep).join('/');
  return {
    meta: {
      bundle, source: rel, sourceAbs: abs, sourceUuid: sourceUuidOf(gc, bundle, abs),
      prefabName: wanted.rootType === 'cc.Prefab' ? (wanted.rootInst?._name ?? null) : null,
      sectionIndex: wanted.si,
      designResolution,
      stats: { ...builder.stats, unresolvedInstanceRefs: builder.unresolved.filter(u => u.category === 'instance-ref').length },
      warnings: wanted.dec.warnings.slice(0, 50),
    },
    assets: builder.assets,
    nodes: [tree],
    unresolved: builder.unresolved,
  };
}

function sourceUuidOf(gc, bundle, absFile) {
  const b = gc.bundle(bundle);
  if (!b) return null;
  const rel = path.relative(b.resDir, absFile).split(path.sep).join('/');
  const m = rel.match(/^import\/..\/(.+)\.[0-9a-f]+\.json$/);
  if (!m) return null;
  for (const u of b.config.uuids || []) if (u === m[1] || decompressUuid(u) === m[1]) return u;
  return null;
}

// ------------------------------------------------------------------ CLI
function printUsage() {
  console.log(`用法: node parse-prefab.mjs <import.json路径> [选项]
  --out <file>          输出到文件(默认 stdout)
  --section <n>         pack 文件时选择第 n 个 section
  --gamecaches <dir>    显式指定 gamecaches 根目录
  --bundle <name>       资产查找提示 bundle 名
  --max-nest-depth <n>  嵌套 prefab 最大展开深度(默认 4)
  --no-expand           不展开嵌套 PrefabInstance`);
}
function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const getOpt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  if (!file || args.includes('--help')) { printUsage(); process.exit(file ? 0 : 1); }
  const ir = parsePrefabFile(file, {
    gamecaches: getOpt('gamecaches'),
    bundle: getOpt('bundle'),
    section: getOpt('section') != null ? Number(getOpt('section')) : undefined,
    maxNestDepth: getOpt('max-nest-depth') != null ? Number(getOpt('max-nest-depth')) : undefined,
    expand: !args.includes('--no-expand'),
  });
  const text = JSON.stringify(ir, null, 1);
  const out = getOpt('out');
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text + '\n');
    const s = ir.meta.stats;
    console.error(`OK ${out}: nodes=${s.nodes} compTypes=${Object.keys(s.components).length} sprites=${s.spriteResolved}/${s.spriteRefs} nested=${s.nestedPrefabs} overrides=${s.overridesApplied} unresolved=${ir.unresolved.length}(instRef=${s.unresolvedInstanceRefs})`);
  } else process.stdout.write(text + '\n');
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
