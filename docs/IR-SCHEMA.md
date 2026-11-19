# IR JSON Schema — Cocos UI prefab 中间表示

> 由 `cocos2ugui/parse-prefab.mjs` 生成。输入: gamecaches 中任意 import JSON(普通文件或 pack 文件均可,
> pack 自动选根为 `cc.Prefab` 的 section, 亦可用 `--section N` 指定)。
> 本 IR 是 Cocos→Unity UGUI 转换流水线(P3 映射层)的唯一输入契约。

## 顶层结构

```jsonc
{
  "meta": {
    "bundle": "guide",                       // bundle 名(由输入路径推断, 可 --bundle 覆盖)
    "source": "guide/179272519949216/res/import/ba/ba7f6f59-….e727e.json",  // 相对 gamecaches 根
    "sourceAbs": "C:\\…\\ba7f6f59-….json",   // 绝对路径
    "sourceUuid": "baf29ZBAJM44Mm3o5vI3oT",  // 该资产在 config.json 里的(压缩)uuid
    "prefabName": "pfb_demo_guide",             // 根 cc.Prefab._name(非 prefab 根为 null)
    "sectionIndex": 0,                       // pack 内 section 序号(普通文件恒 0)
    "designResolution": { "width": 750, "height": 1334 },  // 根节点 UITransform 内容尺寸(缺省 750×1334)
    "stats": {                               // 解码统计(验收用)
      "nodes": 9, "components": {"cc.Sprite": 4, …}, "customScripts": {"<哈希>": 1, …},
      "spriteRefs": 4, "spriteResolved": 4, "nestedPrefabs": 0, "overridesApplied": 0,
      "unresolvedInstanceRefs": 0
    },
    "warnings": []                           // 解码器内部告警(未知 mask/DataTypeID 等, 样例中为 0)
  },

  "assets": [                                // 本 prefab 引用到的全部外部资产(去重, 按首次引用序)
    {
      "uuid": "25xxNqIBhLu60Ugtv1gdok@f9941", // 原始(压缩)uuid, @f9941=spriteFrame 子资产
      "kind": "spriteFrame",                 // spriteFrame|texture|prefab|font|asset|image
      "name": "texture/sprite_nine/spriteFrame", // config.json paths 里的资产路径名
      "file": "guide/…/res/native/25/25c7136a-….7ad96.png", // 相对 gamecaches 根的实际文件(png/jpg; kind!=spriteFrame 时为 import json)
      "exists": true,                        // 该文件是否真实存在(验收硬指标)
      "sprite": {                            // 仅 spriteFrame: 从 spriteFrame 文档展开的图集裁剪信息
        "name": "sprite_nine", "rect": {"x":0,"y":0,"width":79,"height":80},
        "offset": {"x":0,"y":0}, "originalSize": {"width":79,"height":80},
        "rotated": false, "capInsets": [30,30,30,30]   // 九宫格 [x,y,w,h]
      },
      "textureUuid": "25xxNqIBhLu60Ugtv1gdok", // 底图 base uuid(_textureSource 解析结果)
      "prefabName": "item_card",             // 仅 kind=prefab: 被引用 prefab 的名字
      "note": "…"                            // 解析失败原因(成功时无)
    }
  ],

  "nodes": [ IRNode ],                       // 恒为单根数组(根 = cc.Prefab.data 节点)

  "unresolved": [                            // 未解决项; category 见下
    { "location": "root.children[2].components[0]._spriteFrame", "reason": "…", "category": "asset" }
  ]
}
```

## IRNode

```jsonc
{
  "name": "_nd:bg",                  // cc.Node._name; 无名挂载点展开后取被挂 prefab 根名
  "active": true,                    // _active !== false
  "layer": 33554432,                 // _layer 原始值(UI 层 bitmask)
  "position": {"__type__":"cc.Vec3","x":-236.02,"y":110.8,"z":0},  // _lpos
  "scale":    {"__type__":"cc.Vec3", …},     // _lscale(缺省 [1,1,1] 时可能为 null)
  "rotation": {"__type__":"cc.Quat", …},     // _lrot(四元数)
  "fileId": "ea2cdBAHVxD9oCKClsaCBcU",       // 本节点在其所属 prefab 资产内的 PrefabInfo.fileId
  "mountedFrom": null,                       // 嵌套展开来源; 挂载点展开出的节点为
                                            //   {"prefab":"<被挂 prefab uuid>","fileId":"<挂载点 fileId>","instanceFileId":"<PrefabInstance.fileId>"}
  "targetOverrides": [ … ],                  // 可选: PrefabInfo.targetOverrides(cc.TargetOverrideInfo)原样保留
  "components": [ IRComponent ],             // 引擎组件(cc.*/sp.*)
  "customScripts": [ IRScript ],             // 自定义脚本组件(类名=22/23 位压缩 uuid 哈希)
  "children": [ IRNode ]
}
```

## IRComponent / IRScript

```jsonc
{
  "type": "cc.Sprite",               // 组件类名(customScripts 中此字段名为 "uuid")
  "fileId": "571VreJIhMwbpl7dhW0Bcg",// CompPrefabInfo.fileId(嵌套覆盖/引用定位用)
  "props": {                         // 该组件被序列化的全部字段展开(按 mask 实际出现者)
    "_sizeMode": 0, "_type": 1,
    "_spriteFrame": { "$asset": 1, "uuid": "25xxNqIBhLu60Ugtv1gdok@f9941" },
                                    //   资产引用: $asset = assets[] 下标, uuid 同步冗余
                                    //   viaDep:true 表示经 depend 表回填(提升到顶层的组件)
    "_contentSize": {"__type__":"cc.Size","width":682,"height":227},
    "_color": {"__type__":"cc.Color","uint32":4288701247,"r":255,"g":219,"b":185,"a":254},
    "_isSystemFontUsed": false,
    "_font": { "$asset": 2, "uuid": "4cGtnMpkpByqloH68jVg7R" }
  }
}
```

**值类型编码**(props 里出现的内联对象):
- `cc.Vec2 {x,y}` / `cc.Vec3 {x,y,z}` / `cc.Vec4|cc.Quat {x,y,z,w}`
- `cc.Color {uint32, r,g,b,a}`(uint32 为序列化原值)
- `cc.Size {width,height}` / `cc.Rect {x,y,width,height}` / `cc.Mat4 {m[16]}`
- 资产引用 `{ $asset: <assets 下标>, uuid: <原始 uuid> }`
- 实例引用 `{ $inst: <所属 section Instances 数组下标> }` —— 同一下标在同一 import 文件内稳定,
  供 P3 层把 custom script 的 `p_xxx` 引用对回节点/组件; 跨 section 无意义(已文档化)
- 自定义反序列化类(`__custom`, 如 cc.SpriteFrame): `{ __type__, content }`

## unresolved 的 category

| category | 含义 | 验收口径 |
|---|---|---|
| `instance-ref` | 实例反向引用解析失败 | **必须为 0**(验收硬指标) |
| `asset` | 资产 uuid 定位失败(缺文件/跨包未缓存) | 记录, P2 资产层兜底 |
| `nested-prefab` | 嵌套展开异常(加载失败/覆盖目标缺失/超深度) | 逐条归因; 引擎同行为跳过 |
| `other` | 上述之外 | 逐条归因 |

## 用法

```bash
node cocos2ugui/parse-prefab.mjs <import.json路径> [--out out.json] [--section N]
     [--gamecaches <dir>] [--bundle <name>] [--max-nest-depth 4] [--no-expand]
node cocos2ugui/verify-ir.mjs cocos2ugui/ir/*.json   # 验收检查(UITransform 覆盖率/实例引用/贴图存在性)
```
