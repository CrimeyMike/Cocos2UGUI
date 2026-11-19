# build.json 接口契约（P3 产出 / P4 消费）

P3（map-to-ugui.mjs）对每个面板产出 `cocos2ugui/build/<panel>.build.json`，P4（Unity 生成器）严格按本契约消费。字段名即 Unity 侧语义。

```jsonc
{
  "meta": {
    "panel": "demo-pfb_demo_guide",            // 面板标识 = bundle-prefab 名（唯一）
    "bundle": "guide",
    "designResolution": { "width": 750, "height": 1334 },  // Canvas Scaler 引用分辨率
    "match": 1,                               // 竖屏按高匹配
    "generatedBy": "map-to-ugui v1",
    "flags": ["no-spine-runtime"]             // 面板级标记
  },
  "sprites": [                                 // 本面板用到的全部切图（去重）
    {
      "name": "sprite_nine",                       // Sprite 名（组件里用此名引用）
      "source": "C:/.../native/xx/uuid.hash.png", // 源图绝对路径（图集或单图）
      "rect": { "x": 0, "y": 0, "w": 79, "h": 80 }, // Cocos 坐标系切图（y 自顶向下）
      "rotated": false,                        // true=图集内旋转 90°，Unity 需裁剪方案
      "border": [20, 20, 20, 20]               // 九宫格 [L,B,R,T]，无则 null
    }
  ],
  "scripts": [                                 // 面板内自定义脚本（生成 stub C#）
    {
      "uuidHash": "08db1hSeoxLGYSTl2zwmH+v",   // Cocos 脚本 UUID（类名后缀用前 6 位）
      "className": "GuideDialog_08db1h",       // 生成的 stub 类名（P3 定名，P4 直接用）
      "fields": [ { "name": "dialogLabel", "cocosType": "cc.Label", "tooltip": "倒计时文本" } ]
    }
  ],
  "root": {                                    // 递归节点树；每个节点：
    "name": "pfb_demo_guide",
    "active": true,
    "rect": {                                   // 全部为最终 UGUI 值（P3 完成换算）
      "anchorMin": [0.5, 0.5], "anchorMax": [0.5, 0.5],
      "offsetMin": [-375, -667], "offsetMax": [375, 667],
      "pivot": [0.5, 0.5],
      "anchoredPosition": [0, 0], "sizeDelta": [750, 1334],
      "rotationZ": 0, "scale": [1, 1, 1]
    },
    "components": [
      { "type": "Image", "props": { "sprite": "sprite_nine", "imageType": "Sliced", "color": [1,1,1,1], "raycastTarget": true } },
      { "type": "Text",  "props": { "text": "…", "fontSize": 28, "color": [1,1,1,1], "alignment": "UpperCenter", "overflow": "Overflow", "lineSpacing": 1.2, "richText": true } },
      { "type": "Button", "props": { "interactable": true, "transition": "ColorTint" } },
      { "type": "Layout", "props": { "layoutType": "Vertical", "spacing": 5, "padding": [10,10,10,10], "childAlignment": "UpperCenter", "resizeMode": "ControlSize" } },
      { "type": "RectMask2D", "props": {} },
      { "type": "CanvasGroup", "props": { "alpha": 1, "blocksRaycasts": true } },   // UIOpacity 映射
      { "type": "ScrollRect", "props": { "content": "content节点名", "horizontal": false, "vertical": true, "movementType": "Elastic" } },
      { "type": "CustomScript", "props": { "script": "08db1hSeoxLGYSTl2zwmH+v" } },
      { "type": "Marker", "props": { "reason": "sp.Skeleton: 需 spine-unity", "source": "sp.Skeleton" } } // 无法映射的组件统一 Marker
    ],
    "children": [ /* 递归同构 */ ]
  },
  "unmapped": [ { "node": "_nd:xxx", "component": "cc.Graphics", "reason": "矢量绘制无 UGUI 等价" } ]
}
```

硬性约定：
1. `rect` 内全部字段是 P3 换算完成的**最终 UGUI 语义值**（含 Widget→锚点、父锚点位置换算、Y 轴/offset 符号处理）；P4 不做任何数学，只赋值。
2. `components[].type` 枚举：Image/Text/Button/Layout/RectMask2D/CanvasGroup/ScrollRect/CustomScript/Marker（不够再协商扩表，不得私加）。
3. sprite 引用一律用 `sprites[].name`；脚本引用一律用 `scripts[].uuidHash`。
4. P4 遇 `Marker` 组件：挂空 MonoBehaviour 标记类 + 记录到生成报告，不失败。
5. 校验：P3 输出后自跑 `node validate-build.mjs <file>`（schema+引用完整性）；P4 构建后反读 prefab 与 build.json diff。
