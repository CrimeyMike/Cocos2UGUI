# UI 层级命名规范（源自 参考模板工程 参照工程实证 + Cocos 源命名映射）

制定依据：参照工程 194 个 UI prefab（约 1.5 万节点）命名统计；由 `normalize-names.mjs` 在流水线 P3.5 层自动执行。

## 规范

| 维度 | 规则 | 示例 |
|------|------|------|
| 根节点 | 保持 panel id 不变（= prefab 资产名） | `demo_rank_reward` |
| 风格 | snake_case 全小写 | `remainingTime` → `remaining_time` |
| 图片节点 | `img_` 前缀 | `img_icon`、`img_bg` |
| 文本节点 | `lbl_` 前缀 | `lbl_title`、`lbl_value` |
| 按钮节点 | `btn_` 前缀 | `btn_close` |
| 列表条目 | `item_` 前缀 + 序号去重 | `item_prop1..item_prop7` |
| 特效节点 | `fx_` 前缀（spine 等） | `fx_anim` |
| 结构骨架 | 裸名：`root/bg/panel/center/content/title/layout/top/down/left/right` | |
| 滚动脚手架 | 对齐 Unity 默认名：`scroll_view → Viewport → Content` | |
| 同父同名 | 自动追加 `_2.._n` | `lbl_text, lbl_text_2 …` |

## 源标记映射表（Cocos 原工程命名 → 本规范）

| Cocos 源标记 | 含义 | 映射 |
|------|------|------|
| `_spr:` / `_sp:` / `spr:` | 精灵 | `img_` |
| `_lab:` / `lab:` / `p_lab_*` | 文本 | `lbl_` |
| `_btn:` | 按钮 | `btn_` |
| `_arr:` | 数组挂载条目 | `item_` |
| `_nd:` / `nd:` / `p_nd_*` | 普通节点 | 裸名 |
| `_spine:` | spine 骨骼 | `fx_` |
| `_rt:` | 富文本 | `lbl_` |
| `_pro:` / `_edx:` | 进度条 / 输入框 | 裸名 |
| `p_<标记>_<词干>` | 脚本属性式命名 | 按标记映射 |

## 词干词典（高频词 + 源拼写错误）

`label/lab/txt → text`，`des → desc`，`titile → title`（源数据拼写错误修正）。
其余词干保留原文（规范化大小写/分隔符后），不做语义翻译。

## 配套约定

- **脚本剥离**：`-stripScripts` 构建模式下 prefab 只含 UGUI 官方组件（Image/Text/Button/Layout/RectMask2D/CanvasGroup/ScrollRect 及 Unity 内置），不生成/挂载任何自定义脚本与 Marker。
- **脚本信息 sidecar**：每个面板 `sidecars/<panel>.scripts.json` 记录节点路径 + 原脚本 uuid，供模板架构适配时反查。
- **幂等**：改名器可重复运行（第二遍 0 改名）；原始命名备份于 `build-raw/`。
