# Cocos → UGUI 转换流水线（全景）

```mermaid
flowchart TD
    SRC1["🟢 编辑器工程源文件<br/>.prefab/.scene + meta/plist"] --> P1E
    subgraph P1E["P1 编辑器入口 · parse-editor-prefab.mjs"]
        A0["__id__ 引用式反序列化<br/>meta/plist 切图解析 · ScrollView._content 精确解析"]
    end
    P1E -->|"ir/ (同一契约)"| P3

    SRC2["🔵 解包缓存（只读）<br/>wxapkg 解包 / 游戏缓存 import JSON"] --> P1
    subgraph P1["P1 解包入口 · parse-prefab.mjs"]
        A1["压缩序列化反序列化<br/>嵌套 prefab 展开 · 资产引用落地"]
    end
    P1 -->|"ir-all/ (IR 中间表示)"| P3

    subgraph P3["P3 映射层 · map-to-ugui.mjs"]
        B1["Cocos 语义 → UGUI<br/>Widget→锚点/offset · capInsets→border<br/>y 轴换算 · 750×1334"]
    end
    P3 -->|"build/ (build.json 契约)"| P35

    subgraph P35["P3.5 命名规范化 · normalize-names.mjs"]
        C1["剥源标记 _spr/_lab/_btn/_arr → img_/lbl_/btn_/item_<br/>同父去重 · 幂等<br/>脚本信息 → sidecars/"]
    end
    P35 -->|"改名后 build.json<br/>(原名备份 build-raw/)"| P4

    subgraph P4["P4 生成层 · Unity batchmode"]
        D1["BuildAll -stripScripts<br/>共享贴图库 _lib(931 PNG)<br/>rotated 切图像素级烘焙(40)<br/>只挂官方组件"]
    end
    P4 --> V{PrefabVerifier<br/>逐字段 diff}

    V -->|"diff≠0"| P4
    V -->|"diff=0 · exit 0"| OUT

    OUT[("✅ 产物<br/>Assets/Panels/ 334 个 prefab<br/>纯 UGUI 官方组件 · 规范命名")]

    OUT --> USE1["模板架构适配<br/>sidecars/ 反查原脚本 uuid"]
    OUT --> USE2["人工视觉验收<br/>截图 captures/ + 金标准比对"]

    TAIL["⚠️ 已知长尾（不阻塞）<br/>spine 骨骼=空节点 · 动态赋图/文本为空<br/>cc.Graphics 无 UGUI 等价"]
    OUT -.-> TAIL
```

## 机器耗时（全量重跑 ≈ 5 分钟，全链路幂等）

| 步骤 | 命令 | 耗时 |
|------|------|------|
| P1+P3（编辑器工程） | `node batch-all.mjs --editor <工程根>` | 按规模 |
| P1+P3（解包缓存） | `node batch-all.mjs --gamecaches <dir>` | 98 s |
| P3.5 | `node normalize-names.mjs` | < 5 s |
| P4 构建 | `Unity -executeMethod Cocos2UguiBuilder.BuildAll -stripScripts` | ~60 s |
| P4 验证 | `Unity -executeMethod PrefabVerifier.VerifyAll -stripScripts` | ~30 s |

规范文档：[UI-NAMING-SPEC.md](UI-NAMING-SPEC.md) · 契约：[BUILD-SCHEMA.md](BUILD-SCHEMA.md)
