# Cocos IR → UGUI build.json 映射规则表 (P3)

> 工具: `map-to-ugui.mjs` · 输入: IR(`IR-SCHEMA.md`) · 输出: `build/<panel>.build.json`(`BUILD-SCHEMA.md`)
> 规则优先级依据全量统计(decode-report §5): Sprite 6235 > Label 2731 > Widget 843 > Layout 452 > Graphics/Mask 210 > sp.Skeleton 660 > ScrollView 18。
> **每条规则标注实证样例**: `guide` = demo-pfb_demo_guide, `home` = demo-demo_rank_reward, `battle` = demo-ui-demo_statistic_view, `synthetic` = map-tests/fixture-synthetic.json(手工构造, 仅用于语料中不存在的组合, 已注明)。

---

## 0. 两个引擎的坐标系对照

| 概念 | Cocos Creator 3.8 | Unity UGUI | 结论 |
|---|---|---|---|
| 屏幕方向 | X 右, **Y 上** | X 右, **Y 上** | 数值同号直拷, 无需翻转 |
| 节点矩形锚点 | `UITransform._anchorPoint` (0~1) | `RectTransform.pivot` | 语义一致, 直拷 |
| 父参考系 | 子节点 `_lpos` 相对**父锚点** | anchoredPosition 相对**子节点自身 anchors 在父矩形内的插值点** | 无 Widget 时把子锚点取"父锚点", 两参考系重合(§3) |
| 尺寸 | `_contentSize` | `sizeDelta`(锚点重合时) | 无拉伸轴直拷(§2) |
| 切图 rect | SpriteFrame rect, **y 自顶向下** | — | 原样透传, P4 处理(BUILD-SCHEMA 已约定) |

**UGUI 恒等式**(纯代数推导, 与锚点无关; 生成器在"已舍入(4 位小数)空间"里按序派生, 保证恒等式在输出精度内成立):

```
sizeDelta        = offsetMax - offsetMax... 即 sizeDelta = offsetMax - offsetMin   (逐轴)
anchoredPosition = offsetMin + pivot * sizeDelta                                  (逐轴)
实际尺寸          = sizeDelta + (anchorMax - anchorMin) * 父尺寸
```

生成顺序: 先 `offsetMin/offsetMax`(r4) → `sizeDelta = r4(offsetMax-offsetMin)` → `anchoredPosition = r4(offsetMin+pivot*r4·sizeDelta)`, `pivot` 亦先 r4。
**依据**: UGUI RectTransform 定义(anchorMin/Max 为父矩形分数, offsetMin/Max 为矩形角相对锚点参考的偏移, anchoredPosition 为 pivot 相对锚点插值点的偏移); 推导见 map-tests/t1 注释。**验收**: validate-build.mjs 对每节点两条恒等式做 ±1e-3 断言。

---

## 1. Widget → anchors + offsets(布局对齐; 全量 843 处)

### 1.1 `_alignFlags` 位定义(引擎 `cocos/ui/widget-component.ts`, 自 2.x 沿用)

| 位 | 值 | 含义 | 对应 Unity 锚点 |
|---|---|---|---|
| TOP | 1 | 贴父顶(边距 `_top`) | anchor.y = 1 |
| MID | 2 | 垂直居中 | anchor.y = 父锚点 y |
| BOT | 4 | 贴父底(边距 `_bottom`) | anchor.y = 0 |
| LEFT | 8 | 贴父左(边距 `_left`) | anchor.x = 0 |
| CENTER | 16 | 水平居中 | anchor.x = 父锚点 x |
| RIGHT | 32 | 贴父右(边距 `_right`) | anchor.x = 1 |

**位值实证**(样例出现过的全部组合, 均与节点实际尺寸/位置吻合):
- `45 = TOP|BOT|LEFT|RIGHT` → 四边拉伸: guide/home/battle 三根节点(contentSize 750×1334 == designResolution, 拉伸语义自洽);
- `1 = TOP` → home `bg`/`_nd:city`/`_scroll:content`/`_nd:rank_name`(4 处, 全部"顶边到父顶距离 == _top", 见 §1.3 验算);
- `5 = TOP|BOT` → home `_btn:close`(高 1334 == 父高)、vlist `content`(高 250 == 父高 250)——纵向拉伸;
- `41 = TOP|LEFT|RIGHT` → home `view`(宽 520 == 父宽 520)——横向拉伸 + 贴顶。

### 1.2 每轴算法(独立处理 X/Y)

```
X 轴: L=flags&8, R=flags&32, C=flags&16
  L&&R : anchorMin.x=0, anchorMax.x=1, offsetMin.x=+mLeft,  offsetMax.x=-mRight      (水平拉伸)
  L    : anchorMin.x=anchorMax.x=0,     offsetMin.x=+mLeft,  offsetMax.x=+mLeft+w     (贴左)
  R    : anchorMin.x=anchorMax.x=1,     offsetMax.x=-mRight, offsetMin.x=-mRight-w    (贴右)
  C    : 锚点取父锚点; 等效 lpos.x := 父宽*(0.5-父锚点.x) 后走"无 Widget"分支         (水平居中)
  无   : 锚点取父锚点; lpos.x 原值(§3)                                                 (自由定位)
Y 轴: T=flags&1, B=flags&4, M=flags&2 (w/h 为该节点 _contentSize 分量)
  T&&B : anchorMin.y=0, anchorMax.y=1, offsetMin.y=+mBottom, offsetMax.y=-mTop        (垂直拉伸)
  T    : anchorMin.y=anchorMax.y=1,    offsetMax.y=-mTop,   offsetMin.y=-mTop-h       (贴顶)
  B    : anchorMin.y=anchorMax.y=0,    offsetMin.y=+mBottom, offsetMax.y=+mBottom+h   (贴底)
  M    : 等效 lpos.y := 父高*(0.5-父锚点.y) 后走"无 Widget"分支                        (垂直居中)
  无   : 同"无 Widget"
```

**边距**: `_top/_bottom/_left/_right` 默认绝对像素; 对应 `_isAbsTop/_isAbsBottom/_isAbsLeft/_isAbsRight === false` 时为**父尺寸百分比**(mTop = `_top` × 父高)。实证: home `view` 的 `_isAbsTop:false`(边距 0×581.047=0)。
**惯性字段**: 只有序列化但位未置的边距不参与布局(实证: home `_scroll:content` 带 `_bottom:79.891` 但 flags=1 无 BOT 位, 输出不采用)。`_originalWidth/_originalHeight` 是编辑器参考值, 忽略。

### 1.3 验算公式(Widget 语义 ↔ UGUI 输出互证)

```
Cocos: 节点顶边(父空间, 原点=父锚点) = lpos.y + (1-anchorPoint.y)*h ; 父顶 = 父高*(1-父锚点.y)
       约束: 父顶 - 节点顶边 = _top
UGUI : 节点顶边 = 父顶 + offsetMax.y   (anchorMax.y=1 时锚点参考=父顶)
```
实证(home `_nd:city`, `_top=287.913`, 默认 100×100/锚点 .5/.5, 父 750×1334 锚点 .5/.5):
Cocos: 顶边 = 329.087+50 = 379.087, 父顶 667, 667-379.087 = 287.913 ✓
UGUI 输出: `offsetMax.y = -287.913`, 复算顶边 = 667-287.913 = 379.087 ✓(map-tests/t1 例 3)

golden 用例(map-tests/t1 8 例 + t9 6 例): 四边拉伸(45)/贴顶(1)/纵拉(5)/横拉+贴顶(41)/贴顶+自定义锚点/父锚点非中心的纵拉; CENTER(16)/MID(2)/TOP_LEFT(9)/BOTTOM_RIGHT(36)/百分比边距在 synthetic(语料三样例无这些组合, 构造样例, 数值手工推导)。

---

## 2. `_anchorPoint → pivot`, `_contentSize → sizeDelta`

- `pivot = [r4(_anchorPoint.x), r4(_anchorPoint.y)]`, 缺省 (0.5, 0.5)。
- 无 Widget 拉伸的轴: `sizeDelta 分量 == _contentSize 分量`; 拉伸轴上 `sizeDelta = offsetMax-offsetMin`(边距差), 实际尺寸由父尺寸决定。
- **rounding 注意**: spine 节点的怪锚点如 0.5431553278924325 → 0.5432(4 位), 派生量全部用舍入后值计算保证恒等式(battle `_spine:orange_spine_1` 为回归用例)。
- UITransform props 为空 → Cocos 默认 `contentSize 100×100`(引擎 `ui-transform.ts` 默认值)。实证: home `_nd:city` 空 props, 其 Widget 验算按 100×100 成立(§1.3)。

## 3. `_lpos → anchoredPosition`(无 Widget 轴)

**规则**: 无 Widget 的轴, 子节点锚点取 **父节点的 `_anchorPoint`**。此时 UGUI 锚点参考点(anchors=父锚点分数在父矩形内的位置)与 Cocos 的"父锚点原点"物理重合 → `anchoredPosition 分量 = _lpos 分量` **直拷**(两轴均 Y 向上, 无符号翻转)。`offsetMin = lpos - anchorPoint*size`, `offsetMax = offsetMin + sizeDelta`。

**实证**:
- 父锚点=中心: guide `nameBg` lpos(-236.023, 110.806) → anchoredPosition 同值, offsetMin = (-296.023, 90.806)(= lpos − 0.5×size);
- **父锚点≠中心**: battle `item_card`(父 `_nd:red_card_layer` 锚点 (0,0.5)) → anchorMin/Max.x=0, anchoredPosition=(43.12, −2.448)==lpos; home vlist `content`(父锚点 (0,0.5))同(t1 例 6/t3 例 2/例 5);
- **父尺寸变化**: 拉伸轴 sizeDelta=0(如 home `view` 横拉), 实际宽 = (1−0)×父宽 → 父变子变, 等价 Cocos Widget 运行时行为(t3 例 4)。

## 4. Y 轴 / offset 符号(重点实证)

**结论**: 两引擎 rect 空间同向(X 右 Y 上), 但 Cocos `_top/_right` 是"**到**父上/右边的距离"(正值=向内缩), UGUI `offsetMax` 是"矩形上/右 edge **超出**锚点参考的偏移"(正值=向外扩) → **取负**; `_bottom/_left` 方向本就一致 → 不变:

```
offsetMin = (+_left, +_bottom)    符号不变
offsetMax = (-_right, -_top)      符号翻转
```

**实证(贴顶节点实数, map-tests/t7)**:
1. home `bg` **`_top = -180`**(顶边越出父顶 180px): Cocos 顶边 = pos.y(−3) + 0.5×1700 = 847, 父顶 667, 847−667 = 180 = −_top ✓; UGUI 输出 **`offsetMax.y = +180`(正!)** —— 若不翻号得 −180 则顶边只到 487, 错 360px;
2. home `_nd:city` `_top = +287.913` → `offsetMax.y = −287.913`(负), 复算顶边 379.087 == Cocos ✓;
3. 往返自洽: bg 底边 Cocos = 847−1700 = −853; UGUI 复算 = 父顶 667 + offsetMin.y(−1520) = −853 ✓。
4. guide 样例内: 根节点 Widget 45 四边距 0(符号退化为 0, 不构成判别); guide 面板唯一 Widget 即此根节点, 故符号判别实证取 home 的贴顶节点(guide/home/battle 为同一流水线同一公式, t7 已锁定)。

## 5. 九宫格 `capInsets → border`, `Sprite._type → Image.imageType`

**引擎实证**(cocos-engine v3.8.8 `cocos/2d/assets/sprite-frame.ts): `_capInsets` **不是 Rect 而是数组**, 下标即语义:
```ts
const INSET_LEFT = 0; const INSET_TOP = 1; const INSET_RIGHT = 2; const INSET_BOTTOM = 3;
```
→ 换算到 BUILD-SCHEMA 的 `border [L,B,R,T]`:

```
border = [ capInsets[0], capInsets[3], capInsets[2], capInsets[1] ]   // [L,T,R,B] → [L,B,R,T]
capInsets 全 0 → border = null(非九宫格)
```
**旁证**: battle `zd_zk_line_sj`(22×18 横线) capInsets `[11,0,8,0]` → 上下 inset=0, 正是"仅横向拉伸的分割线"; home `jjc_di_green`(50×40) `[21,0,21,0]` 同型。若按 Rect(x,y,w,h) 语义解读会出现 18px 的假"下边", 与图形明显不符。
**golden**(t4): `sprite_nine [30,30,30,30]→[30,30,30,30]`(guide `_nd:bg` 九宫格背景); `common_card_sl [22,7,17,8]→[22,8,17,7]`; `card_di [14,16,14,16]→[14,16,14,16]`; 全 0 → null。

`Sprite._type → Image.imageType`: 0=simple(缺省)→`Simple`, 1=sliced→`Sliced`, 2=tiled→`Tiled`, 3=filled→`Filled`(语料仅出现 0/1)。实证: guide `_nd:bg` `_type:1`→Sliced; guide `_spr:speaker` 无 `_type`→Simple。

## 6. `cc.Sprite → Image`

| Cocos | Unity(Image) | 说明 |
|---|---|---|
| `_spriteFrame`(`$asset`→assets[].sprite) | `sprite: sprites[].name` | 引用切图名; **运行时动态赋值(未序列化)→ `sprite: null`**(不产生悬空引用)。实证: home/battle `_spr:quality/_spr:icon/_spr:class/_spr:bar/_spr:quality_01`(battle 同款×2 克隆) |
| `_type` | `imageType`(§5) | |
| `_color`(cc.Color, Sprite 上未序列化则缺省) | `color: [r,g,b,a]/255` | |
| — | `raycastTarget: true` | Cocos Sprite 默认参与触摸, 统一开(按钮/滚动依赖) |

## 7. rotated 切图策略

`sprites[].rotated` 与 `rect` **原样透传, 不交换 w/h**(BUILD-SCHEMA: rect 为 Cocos 坐标系切图)。Unity Sprite 无法表达"图集内旋转 90°", **P4 裁剪时负责逆旋转**: 从源图按 rect 取出区域后旋转 90° 落成独立 Sprite(Unity `CopyTexture`/`Graphics.Blit` 或生成中间图集)。golden(t6): battle `main_graph_small_01 {714,882,126,30}`、`zd_zk_line_sj`、`zd_light`、`zd_icon_vs`、`zd_sl_icon__ls` 共 5 张 rotated 切图 rect 原样; 4 个节点(红/蓝侧各 2)共用 `main_graph_small_01` 且 sprites[] 去重为 1 条。

## 8. `cc.Label → Text`(全量 2731)

| Cocos | Unity(Text) | 枚举映射 |
|---|---|---|
| `_string` | `text` | 直拷 |
| `_fontSize`(fallback `_actualFontSize`) | `fontSize` | |
| `_color` | `color: [r,g,b,a]/255` | 缺省 [1,1,1,1] |
| `_horizontalAlign` 0/1/2 + `_verticalAlign` 0/1/2(缺省 0/0) | `alignment` | `"Upper|Middle|Lower"+"Left|Center|Right"`; 语料未序列化 _verticalAlign(全为默认 TOP→Upper)。实证: guide `_lab:dialog` _horizontalAlign 0 → UpperLeft |
| `_overflow` 0/1/2/3 | `overflow` | 0 NONE→`Overflow`(h/v 均不裁剪), 1 CLAMP→`Clamp`(Wrap+Truncate), 2 SHRINK→`Shrink`(BestFit), 3 RESIZE_HEIGHT→`ResizeHeight`(v Overflow, Cocos 自动撑高)。实证: `_lab:dialog` _overflow 3→ResizeHeight; home `_lab:lock` 2→Shrink |
| `_lineHeight/_fontSize` | `lineSpacing` | 倍率(Unity lineSpacing 为乘数)。实证: 35/28=1.25, 23/20=1.15, 26/26=1 |
| — | `richText: false` | cc.Label 无富文本(cc.RichText 独立组件, 语料未出现; 若出现按 Marker) |
| `_enableOutline/_outlineColor/_outlineWidth` | — | **无 UGUI Text 等价** → unmapped 记录(建议 P4 叠 Unity `Outline/Shadow` 组件)。guide `label`(精锐特工)、battle 18 处 |
| `_font`(位图字体, 全部 font/font1) | — | BUILD-SCHEMA 无字体表字段 → 每面板聚合一条 unmapped; P4 需用默认动态字体或协商扩表 |

`_isSystemFontUsed` 不单独映射(与 `_font` 同一问题)。

## 9. `cc.UIOpacity → CanvasGroup`(全量 698)

`alpha = _opacity/255`(缺省 255→1; 语义一致: 乘性影响整个子树), `blocksRaycasts: true`。实证: guide/battle 的 UIOpacity 均为空 props(默认不透明)→ alpha 1; 非默认值用 synthetic `_opacity:128 → 0.502`(t9)。

## 10. `cc.Layout → Layout`(全量 452)

| Cocos | Unity(Layout) | 枚举/公式 |
|---|---|---|
| `_layoutType` 0/1/2/3 | `layoutType` | 0→`None`, 1→`Horizontal`, 2→`Vertical`, 3→`Grid` |
| Horizontal: `_spacingX`; Vertical: `_spacingY`(缺省 0) | `spacing` | 标量 |
| `_paddingLeft/Bottom/Right/Top`(缺省 0) | `padding [L,B,R,T]` | **与 border 同序约定**。实证: home `_nd:func_unlock` `_paddingBottom:20` → [0,20,0,0] |
| `_horizontalDirection`(0 L2R/1 R2L) × `_verticalDirection`(0 T2B/1 B2T) | `childAlignment` | Vertical: `${上|下}${左|右}`; Horizontal: 同式; 缺省(0,0)→`UpperLeft`。**默认值 T2B 实证**: home `_nd:content`/`_nd:func_unlock` 首个子节点顶边 y=0 == 容器顶边(锚点 .5,1), 即自顶向下排布; L2R 为引擎文档默认 |
| `_resizeMode` 0/1/2 | `resizeMode` | 0→`None`, 1(CONTAINER, 容器随内容)→`Container`(P4: 容器挂 ContentSizeFitter), 2(CHILDREN, 控制子尺寸)→`Children`。实证: `view`/`_nd:content`/`_nd:red_card_layer` 均 1(父宽==单子×scale 积, 自洽) |
| `_affectedByScale` | — | **UGUI LayoutGroup 忽略子 scale** → unmapped 记录(间距会偏大)。battle 8/8 Layout 全带此标记(卡牌列表按 0.56 缩放排布, 实证 `_nd:red_card_layer` 宽 86.24 == 154×0.56) |

> `resizeMode` 枚举字符串为 P3 定义(`None/Container/Children`, 语义与 Cocos 引擎枚举一一对应); BUILD-SCHEMA 示例值 "ControlSize" 未定义语义边界, 故以本表为准并在此显式约定, P4 按括号内 Unity 配方落地。

## 11. `cc.Mask → RectMask2D`; `cc.Graphics` 伴生消化

- `cc.Mask`(默认 RECT 型模板遮罩)→ `RectMask2D`, props `{}`。实证: home `_scroll:content` 与 `vlist_unlockCard` 两处。
- **`cc.Graphics` 与 Mask 同节点 → 消化**(不产 Marker): Cocos 3.x Mask 的模板绘制依赖节点上的 Graphics; 实证: 语料全部 Graphics(2/2, home)都与 Mask 同节点且仅序列化 `_fillColor`、无任何路径数据 → 判定为遮罩辅助件。独立 Graphics(全量另有 210-2 处)→ `Marker`(矢量无 UGUI 等价)。

## 12. `cc.ScrollView → ScrollRect`(全量 18)

| Cocos | Unity(ScrollRect) |
|---|---|
| `_content`(`$inst`) | `content`: **结构推断** = ScrollView 节点子树 BFS 首个带 `cc.Layout` 的节点名 |
| `horizontal`(缺省 false→false; 序列化 false) | `horizontal` 直拷(实证 home 为 false) |
| `vertical`(缺省 true) | `vertical` |
| `bounceDuration`(缺省 0.23)/`brake` | `movementType`: bounceDuration>0(或缺省)→`Elastic`, 显式 0→`Clamped` |

**$inst 说明**: `_content` 指向原始 section 的 Instances 数组下标, 该表**不在 IR 中**(IR-SCHEMA 明示 $inst 仅同 section 内有意义), 无法静态反解。结构推断依据: Cocos ScrollView 模板的 content 即"被 Layout 排版的滚动容器"; home 样例 ScrollView 节点唯一子节点 `view` 恰带 Layout(CONTAINER), 且根脚本 `p_scroll_content($inst 37) ≠ p_nd_content($inst 4)` 证明 content 不是 `_nd:content` → 推断 `view`。推断失败(无带 Layout 子节点)→ content 置空串 + unmapped 记录。

## 13. `cc.Button → Button`(全量 50)

`interactable = _interactable !== false`; `_transition`: 0→`None`, 1(COLOR)→`ColorTint`, 2(SPRITE)→`SpriteSwap`, 3(SCALE)→**`None` + unmapped 记录**(Unity Button 无缩放过渡; 语料仅 battle `_btn:close` 一处, `_transition:3, _zoomScale:0.9`, golden t8)。Button 的点击区由同节点 Image(raycastTarget=true)承担。

## 14. 无枚举位组件 → `Marker` + `unmapped[]` 记录

| 组件 | Marker reason | 处置 |
|---|---|---|
| `sp.Skeleton`(660) | `sp.Skeleton: 需 spine-unity` | 面板 flags 加 `no-spine-runtime`; 骨骼资产 uuid 已在 IR assets, 归 P6。实证 home×2, battle×4 |
| `cc.ProgressBar`(127) | `cc.ProgressBar: 无 UGUI 组件枚举位(需 Slider/自绘)` | 底图/填充条 Sprite 已按 Image 映射, 仅失去自动填充。home×1, battle×2 |
| `cc.BlockInputEvents`(201) | `cc.BlockInputEvents: 拦截点击穿透` | 全屏 raycastTarget Image 等价承担。home×1(bg 全屏图), battle×1 |
| `cc.Graphics`(独立, 208) | `矢量绘制无 UGUI 等价` | 语料三样例 0 独立出现(§11) |
| 其他未知类型(RichText/EditBox/Toggle/Slider/Animation/Camera…) | `X: 无自动映射规则` | 生成器 default 分支兜底, 三样例未出现 |

## 15. 自定义脚本 → `scripts[]` + `CustomScript`

- 节点侧: `{type:'CustomScript', props:{script: <uuidHash>}}`(引用 `scripts[].uuidHash`, validate 校验)。
- `scripts[]`: `{uuidHash, className, fields}`; `className = PascalCase(prefabName) + '_' + uuid前6位`(BUILD-SCHEMA 示例形态 `GuideDialog_08db1h`; 真实类名在 Cocos 侧是压缩 uuid 哈希, 不可恢复)。
- `fields[]`: 每 prop 一条 `{name, cocosType, tooltip}`。cocosType 按项目命名约定推断: `p_nd_*→cc.Node, p_spr_*→cc.Sprite, p_lab_*→cc.Label, p_btn_*→cc.Button, p_pro_*→cc.ProgressBar, p_spine_*→sp.Skeleton, p_scroll_*→cc.ScrollView, p_pfb_*→cc.Prefab`(值形如 `{$asset}`), 字面量→string/number/boolean, 嵌套对象→json。**实证**: 命名推断与样例节点名 100% 对应(guide 6/6, home 13/13, battle 含 item_card 模板 14/15; 唯 `red_com` 无同名节点 → 标注 `cc.Node/Component`)。
- `$inst` 引用无法静态反解(§12), tooltip 保留 `$inst N (按名推断节点 X)` 供人工/stub 绑定; 字面量原值放 tooltip(`原值: guide_text_1`)。
- 注意: 同一脚本 uuid 在不同面板生成不同 className(Pascal 前缀不同)——P4 按面板生成 stub, 字段一致, 可后续合并。

## 16. 节点级字段

| IR | build | 说明 |
|---|---|---|
| `name` | `name` | 直拷(树内可重名, battle `common_pop_bg`×2; ScrollRect.content 引用按名需唯一——本流水线 content 推断目标 `view` 无重名) |
| `active` | `active` | `_active !== false` |
| `rotation`(cc.Quat) | `rotationZ`(度) | 纯 Z 旋转 `2·atan2(z,w)`; 含 X/Y 分量时取欧拉 Z。两引擎正角同为逆时针, 直拷。语料全部恒等四元数→0(synthetic 45° 回归) |
| `scale` | `scale [sx,sy,1]` | 直拷 |
| `layer/fileId/mountedFrom/targetOverrides` | — | 不映射(语料 targetOverrides 为空; mountedFrom 展平信息由树结构表达) |
| IR 节点 | build 节点 | **1:1, 0 丢弃**(validate 带 IR 对照断言节点数相等) |

## 17. sprites[] 注册

- 项: `{name, source, rect{x,y,w,h}, rotated, border}`; `source` = gamecaches 根(由 `meta.sourceAbs − meta.source` 推得) + `asset.file`, 统一 `C:/` 风格; `rect/rotated` 透传(§7), `border`(§5)。
- `name` 取 `asset.sprite.name`(无则 uuid 尾 8 位); 同名不同图自动加 `-2` 后缀(语料未触发)。
- 去重按 name; 仅注册被 `_spriteFrame.$asset` 实际引用的切图(动态 Sprite 不注册)。计数: guide 4, home 15, battle 22。

## 18. meta

`panel = <bundle>-<prefabName>`(与 IR 文件名一致); `designResolution` 直拷; `match = 1`(竖屏按高匹配, BUILD-SCHEMA); `flags: ["no-spine-runtime"]`(仅当面板含 sp.Skeleton); `generatedBy: "map-to-ugui v1"`。
