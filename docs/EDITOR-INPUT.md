# 编辑器原生工程输入（Cocos Creator 3.x 源文件）

> 入口：`tools/parse-editor-prefab.mjs`。产出与解包入口（`parse-prefab.mjs`）**完全同形的 IR**，
> P3 映射层起的整条下游链路（map-to-ugui → normalize-names → Unity BuildAll/VerifyAll）零改动复用。

## 两种输入对比

| | 解包入口（补充路径） | **编辑器入口（主路径）** |
|---|---|---|
| 输入 | 打包产物 import JSON（压缩序列化） | 工程原生 `.prefab` / `.scene`（可读 JSON） |
| 来源 | wxapkg 解包 / 游戏缓存目录 | Cocos Creator 3.x 工程 `assets/` 目录 |
| 贴图 | 缓存里的 native png + spriteFrame 文档 | 工程图片文件 + `<file>.meta` / `.plist` 图集 |
| 适用 | 只有成品包、无源工程的逆向场景 | **有源工程的正常移植场景** |

## 格式要点（实证：cocos/cocos-test-projects v3.8.7）

- 顶层 JSON 数组，`__id__` = 数组下标；根：`cc.Prefab@N.data.__id__`，场景取 `cc.SceneAsset → cc.Scene` 下带 `cc.Canvas` 的 UI 子树
- 资产引用 `{__uuid__}`（完整连字符 uuid，`@f9941` = spriteFrame 子资产）；节点引用 `{__id__}`
- 枚举为数字（`cc.Sprite._type: 0`、`cc.Widget._alignFlags: 45` 位表同解包路径）
- `cc.Color` 无 `uint32` 字段（r/g/b/a 直读，与 P3 消费方式一致）
- 节点 `_prefab:{__id__}` → `cc.PrefabInfo{asset, fileId}`；组件 `__prefab:{__id__}` → `cc.CompPrefabInfo{fileId}`

## 切图信息解析

| 资产类型 | rect/offset/originalSize/rotated | capInsets |
|---|---|---|
| 独立图片 | `<img>.meta` → `subMetas["f9941"].userData`（trimX/Y, width/height, rawWidth/Height, offsetX/Y, rotated） | 同处 `borderLeft/Top/Right/Bottom` → `[L,T,R,B]` |
| plist 图集 | `<name>.plist`（TexturePacker XML frames） | `<name>.plist.meta` → `subMetas[<帧id>].userData.border*` |

rotated 帧的 rect 语义与解包路径一致：**rect 为原始朝向尺寸，图集物理块为转置**（P4 的像素级烘焙直接复用）。

## 用法

```bash
# 单面板
node tools/parse-editor-prefab.mjs <工程>/assets/ui/panel_a.prefab --out ir/panel_a.json

# 批量（枚举 assets/**/*.prefab）
node tools/batch-all.mjs --editor <cocos工程根>
# 之后: normalize-names → Unity BuildAll/VerifyAll 与解包路径完全一致
```

`--project` 缺省自动上溯定位（`package.json` 含 `creator` 字段或存在 `assets/` + `settings/`）。

## 相对解包路径的增强

- `cc.ScrollView._content` 的 `{__id__}` 可精确解析 → IR 带 `resolvedNodeName`，
  P3 的 ScrollRect.content 用真实节点名（解包路径只能按"首个带 Layout 子节点"结构推断）
- 嵌套 prefab 实例按源文件展开（`--max-nest-depth` 默认 4；组件级 propertyOverrides 精细覆盖 v1 不处理，记录 `overridesApplied=0`）
