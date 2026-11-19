# Cocos2Ugui — Unity 生成层

消费 P3 的 `build/*.build.json`（契约见 [`../docs/BUILD-SCHEMA.md`](../docs/BUILD-SCHEMA.md)），
生成 UGUI prefab、切图 Sprite。仅使用 Unity 内建 API（UGUI），无第三方包。

- Unity 版本：2022.3 LTS（中国版/标准版均兼容，脚本内反射兼容 `spritesheet`/`sprites` 属性名差异）

## 接入你的工程

两种方式任选：

1. **拷入现有工程**（推荐）：把 `Assets/Editor/*.cs` 与 `Assets/Scripts/CocosMarker.cs`
   拷进你的 Unity 工程（Editor 脚本必须在 `Assets/Editor/` 下）。
2. **独立工程**：用 Unity 2022.3 新建空工程（2D 模板），再按方式 1 拷入。

## 目录约定（生成物）

```
Assets/
├── Editor/                 # Cocos2UguiBuilder / PrefabVerifier / PanelCapture / C2UShared
├── Scripts/CocosMarker.cs  # Marker 空 MonoBehaviour（reason/source 字段）
├── StreamingAssets/builds/ # 自测样例 sample-min.build.json + sprites/（相对路径 source 示例）
├── Sprites/_lib/           # 生成: 共享贴图库（按源文件全局去重）+ rot_*.png（rotated 烘焙）
└── Panels/                 # 生成: <panel>.prefab
Reports/                    # 生成: build-report / verification-report（工程根下）
```

## 命令行入口

`UNITY` 与 `PROJ` 按需替换（batchmode 路径含空格要加引号）：

```bash
# 1) 构建: 扫描 build.json -> 导入贴图/切 Sprite/建层级/保存 prefab
#    -stripScripts: 只挂 UGUI 官方组件（不生成 stub、不挂 Marker）
"$UNITY" -batchmode -quit -projectPath "$PROJ" \
  -executeMethod Cocos2UguiBuilder.BuildAll -stripScripts \
  -buildDir "<仓库根>/build" \
  -logFile build.log

# 2) 验证: 重读 prefab 与 build.json 逐字段 diff, diff≠0 时退出码 2
"$UNITY" -batchmode -quit -projectPath "$PROJ" \
  -executeMethod PrefabVerifier.VerifyAll -stripScripts \
  -buildDir "<仓库根>/build" -logFile verify.log

# 3) 截图(可选): 为 prefab 建 Canvas 场景, 输出 750x1334 PNG
"$UNITY" -batchmode -quit -projectPath "$PROJ" \
  -executeMethod PanelCapture.CaptureAll \
  -buildDir "<仓库根>/build" -logFile capture.log
```

### 通用可选参数（三个入口都支持）

| 参数 | 说明 |
|------|------|
| `-buildDir <dir>` | 扫描该目录的 `*.build.json`（默认含 `Assets/StreamingAssets/builds` 样例；也可用环境变量 `C2U_BUILD_DIR`） |
| `-reportDir <dir>` | 报告输出目录（默认 `<工程根>/Reports`） |
| `-panel <name>` | 仅处理/截取指定面板 |
| `-stripScripts` | 只输出 UGUI 官方组件（自定义脚本与 Marker 全部不挂载） |

## 行为要点

1. **贴图**：`sprites[].source` 支持绝对路径或相对 build.json 的路径；共享贴图库按源文件全局去重
   （`Sprites/_lib/`），同一图集只导入一次。Cocos rect 的 y 自顶向下，Unity 自底向上：
   `y_unity = texH - y - h`。`border=[L,B,R,T]` 直接映射 `spriteBorder`。
2. **rotated 切图**：源数据 rect 为原始朝向尺寸，图集内物理块为转置 `(rect.h × rect.w)`。
   生成器像素级提取该块并逆时针旋转 90° 还原，烘焙为独立 Sprite（`rot_<name>.png`）。
3. **层级**：按 `root` 递归建 GameObject+RectTransform，rect 六元组直接赋值（P3 已换算）。
4. **prefab**：面板挂临时 Canvas（CanvasScaler 750×1334 / ScaleWithScreenSize）下保存，
   放入任意场景按 Screen Size 自动缩放。
5. **报告**：`Reports/build-report.json`（每面板 nodes/sprites/rotated/warnings）与
   `Reports/verification-report.json`（逐字段 diff 明细）。

## 快速自测

首次接入后直接跑（无需任何外部数据，样例在 StreamingAssets 里）：

```bash
"$UNITY" -batchmode -quit -projectPath "$PROJ" \
  -executeMethod Cocos2UguiBuilder.BuildAll -stripScripts -logFile build.log
```

成功后 `Assets/Panels/sample-min.prefab` 即为生成结果，可在编辑器中打开检查。
