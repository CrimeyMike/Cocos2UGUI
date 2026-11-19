// Cocos2UguiBuilder.cs — P4 生成器：读取 *.build.json（契约见 cocos2ugui/BUILD-SCHEMA.md），
// 导入贴图切 Sprite、生成 stub C#、按 root 节点树构建 UGUI 层级并保存 prefab。
//
// batchmode 入口:
//   Unity.exe -batchmode -quit -projectPath <proj> -executeMethod Cocos2UguiBuilder.BuildAll
// 可选参数:
//   -buildDir <dir>   仅扫描指定目录（默认: cocos2ugui/build 与 cocos2ugui/unity/build 若存在，
//                     外加 Assets/StreamingAssets/builds 样例目录；也可用环境变量 C2U_BUILD_DIR）
//   -reportDir <dir>  报告输出目录（默认 <工程根>/Reports）
//
// 契约要点（P4 不做数学，只赋值）:
//   * rect 六元组等全部字段为 P3 换算完成的最终 UGUI 语义值。
//   * Cocos rect 的 y 自顶向下，Unity spriteMetaData.rect 的 y 自底向上:
//       y_unity = texH - y - h   （texH 从 PNG/JPEG 文件头读取）
//   * rotated=true 的切图: rect 为原始朝向尺寸（源数据实证: 未裁边帧 rect.w/h == originalSize.w/h），
//     图集内物理块为转置 (rect.h × rect.w)。P5 起从拷贝的图集 PNG 像素级提取该块并逆时针旋转 90°
//     还原，烘焙为独立 Sprite 资产（rot_<name>.png），不再整图占位。
//   * CustomScript 的 stub .cs 若本次运行尚未编译，先以 CocosMarker 占位并在保存后把
//     prefab YAML 中占位组件的 m_Script guid 替换为 stub 的 guid；下次运行直接挂载。
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.UI;

public static class Cocos2UguiBuilder
{
    public const string CustomScriptMagic = "__C2U_CUSTOMSCRIPT__";
    // P7: -stripScripts 时 prefab 只保留 UGUI 官方组件——不生成 stub、不挂载 stub/CocosMarker；
    // 脚本信息由 Node 侧 sidecars/<panel>.scripts.json 保留（normalize-names.mjs 产出）。
    static bool StripScripts => !string.IsNullOrEmpty(C2UShared.GetArg("stripScripts"));
    const string PanelsDir = "Assets/Panels";
    const string SpritesRoot = "Assets/Sprites";
    const string GenScriptsDir = "Assets/GeneratedScripts";
    const string StubNamespace = "Cocos2Ugui.Generated";

    // ---------------- 入口 ----------------

    [MenuItem("Tools/Cocos2Ugui/1. Build All Prefabs")]
    public static void BuildAll()
    {
        var ctx = new BuildContext();
        try
        {
            RunBuildAll(ctx);
        }
        catch (Exception e)
        {
            Debug.LogError("[Cocos2Ugui] BuildAll 失败: " + e);
            throw; // batchmode 下异常 => 退出码 1
        }
        foreach (var line in ctx.SummaryLines())
            Debug.Log("[Cocos2Ugui] " + line);
        Debug.Log("[Cocos2Ugui] BuildAll 完成。panels=" + ctx.panelReports.Count
            + " 失败=" + ctx.fatal.Count + " 报告=" + ctx.ReportPath("build-report.json"));
        if (ctx.fatal.Count > 0)
            throw new Exception("[Cocos2Ugui] " + ctx.fatal.Count + " 个面板构建失败，详见 " + ctx.ReportPath("build-report.json"));
    }

    // ---------------- 主流程 ----------------

    static void RunBuildAll(BuildContext ctx)
    {
        // 0. 发现并解析全部 build.json
        var defs = new List<BuildEntry>();
        var panelSeen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in C2UShared.FindBuildFiles(ctx.warnings))
        {
            BuildDef def;
            try { def = C2UShared.LoadBuild(f); }
            catch (Exception e)
            {
                ctx.fatal.Add("解析失败 " + Path.GetFileName(f) + ": " + e.Message);
                continue;
            }
            if (!panelSeen.Add(def.meta.panel))
            {
                ctx.warnings.Add("重复 panel '" + def.meta.panel + "'，跳过 " + f);
                continue;
            }
            defs.Add(new BuildEntry { buildPath = f, def = def });
        }
        if (defs.Count == 0)
        {
            Debug.LogWarning("[Cocos2Ugui] 未找到任何 *.build.json（可用 -buildDir 指定目录）");
        }

        // 1. 建目录 / 全局收集贴图（按源文件去重，拷到共享 _lib 目录）/ 生成 stub 脚本，
        //    随后一次 Refresh 导入（锁定程序集重载避免域重载打断本方法）
        EnsureFolder(PanelsDir);
        EnsureFolder(SpritesRoot);
        EnsureFolder(SpritesRoot + "/_lib");
        EnsureFolder(GenScriptsDir);
        bool dirty = false;
        foreach (var entry in defs)
        {
            dirty |= CopySpritesGlobal(entry, ctx);
            dirty |= GenerateStubScripts(entry.def, ctx);
        }
        if (dirty)
        {
            EditorApplication.LockReloadAssemblies();
            try { AssetDatabase.Refresh(ImportAssetOptions.ForceUpdate); }
            finally { EditorApplication.UnlockReloadAssemblies(); }
        }

        // 2. 贴图导入（每个源文件仅一次，含 rotated 烘焙），随后按面板收集各自 spriteMap
        var importedGroups = new HashSet<TexGroup>();
        foreach (var entry in defs)
            foreach (var g in entry.groups.List)
                if (importedGroups.Add(g))
                    ImportTextureGroup(g, ctx);
        foreach (var entry in defs)
            ctx.spriteMaps[entry.def.meta.panel] = BuildPanelSpriteMap(entry, ctx);

        // 3. 构建层级并保存 prefab
        EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        foreach (var entry in defs)
        {
            try { BuildPanel(entry, ctx); }
            catch (Exception e)
            {
                ctx.fatal.Add("面板 " + entry.def.meta.panel + " 构建失败: " + e.Message + "\n" + e.StackTrace);
                Debug.LogError("[Cocos2Ugui] 面板 " + entry.def.meta.panel + " 构建失败: " + e);
            }
        }

        // 4. 本次运行新生成、尚未编译的 stub：把 prefab 中占位组件的 m_Script guid 换成 stub guid
        foreach (var kv in ctx.deferredPrefabs)
            ApplyCustomScriptGuidSwap(kv.Key, kv.Value, ctx);

        // 5. 报告
        WriteBuildReport(ctx);
    }

    // ---------------- 贴图拷贝与分组（全局共享库） ----------------

    /// <summary>
    /// 共享贴图库: 按源文件绝对路径全局分组，同一图集只拷贝/导入一次（Assets/Sprites/_lib/）。
    /// 组内切图取全部引用面板的并集; 同名同 rect 同 border 视为共享定义，同名不同义告警并保留先到者。
    /// 每个面板记录自己引用的组与切图定义，供导入后挑选 spriteMap。
    /// </summary>
    static bool CopySpritesGlobal(BuildEntry entry, BuildContext ctx)
    {
        bool dirty = false;
        var def = entry.def;
        if (def.sprites == null) return false;
        var report = entry.EnsureReport(ctx);

        foreach (var s in def.sprites)
        {
            if (s == null || string.IsNullOrEmpty(s.name) || string.IsNullOrEmpty(s.source) || s.rect == null)
            {
                report.warnings.Add("sprites[] 条目缺 name/source/rect，跳过");
                continue;
            }
            entry.panelSprites.Add(s);  // 面板自己的引用清单（计数用）

            string src = C2UShared.ResolveSource(s.source, entry.buildPath);
            var g = ctx.groupBySource.TryGetValue(src, out var found) ? found : null;
            if (g == null)
            {
                int tw, th;
                if (!File.Exists(src) || !C2UShared.TryReadImageSize(src, out tw, out th))
                {
                    report.warnings.Add("源图不存在或无法读取尺寸，跳过: " + src);
                    continue;
                }
                string ext = Path.GetExtension(src);
                if (string.IsNullOrEmpty(ext) || !string.Equals(ext, ".png", StringComparison.OrdinalIgnoreCase) && !string.Equals(ext, ".jpg", StringComparison.OrdinalIgnoreCase) && !string.Equals(ext, ".jpeg", StringComparison.OrdinalIgnoreCase))
                    ext = ".png";
                // 文件名全局去重: 同名不同源加短哈希后缀
                string baseName = C2UShared.SafeName(s.name);
                string fileName = baseName + ext.ToLowerInvariant();
                if (!ctx.libFileNames.Add(fileName))
                    fileName = baseName + "_" + Hash8(src).Substring(0, 6) + ext.ToLowerInvariant();
                string libDirAbs = Path.Combine(C2UShared.ProjectRoot, SpritesRoot.Replace('/', Path.DirectorySeparatorChar), "_lib");
                Directory.CreateDirectory(libDirAbs);
                g = new TexGroup
                {
                    sourceAbs = src,
                    texW = tw,
                    texH = th,
                    assetPath = SpritesRoot + "/_lib/" + fileName,
                    destAbs = Path.Combine(libDirAbs, fileName),
                };
                File.Copy(src, g.destAbs, true);
                ctx.libFileNames.Add(fileName);
                ctx.groupBySource[src] = g;
                ctx.globalGroups.Add(g);
                dirty = true;
            }
            // 并集去重: 同名切图定义
            var dup = g.sprites.FirstOrDefault(x => x.name == s.name);
            if (dup == null)
            {
                g.sprites.Add(s);
            }
            else if (!SameRect(dup.rect, s.rect) || dup.rotated != s.rotated || !SameBorder(dup.border, s.border))
            {
                ctx.warnings.Add("共享图集内同名切图定义冲突，保留先到者: " + s.name + " @ " + Path.GetFileName(g.sourceAbs) +
                    " (来自面板 " + def.meta.panel + ")");
            }
            if (!entry.groups.List.Contains(g)) entry.groups.List.Add(g);
        }
        return dirty;
    }

    static bool SameRect(RectDef a, RectDef b)
    {
        return Math.Abs(a.x - b.x) < 0.01f && Math.Abs(a.y - b.y) < 0.01f && Math.Abs(a.w - b.w) < 0.01f && Math.Abs(a.h - b.h) < 0.01f;
    }

    static bool SameBorder(float[] a, float[] b)
    {
        if (a == null || b == null) return a == b || (a == null && b == null);
        if (a.Length < 4 || b.Length < 4) return false;
        for (int i = 0; i < 4; i++) if (Math.Abs(a[i] - b[i]) > 0.01f) return false;
        return true;
    }

    /// <summary>全局导入一个图集组（每个源文件仅调用一次）: Single/Multiple 切图 + rotated 烘焙，结果挂在组上。</summary>
    static void ImportTextureGroup(TexGroup g, BuildContext ctx)
    {
        var importer = AssetImporter.GetAtPath(g.assetPath) as TextureImporter;
        if (importer == null)
        {
            ctx.warnings.Add("TextureImporter 获取失败: " + g.assetPath);
            return;
        }
        importer.textureType = TextureImporterType.Sprite;
        importer.spritePixelsPerUnit = 100f;
        importer.mipmapEnabled = false;
        importer.npotScale = TextureImporterNPOTScale.None;
        importer.alphaIsTransparency = true;
        importer.textureCompression = TextureImporterCompression.Uncompressed;
        importer.maxTextureSize = MaxSizeFor(g.texW, g.texH, ctx.warnings);
        importer.wrapMode = TextureWrapMode.Clamp;

        bool onlyOne = g.sprites.Count == 1;
        var s0 = g.sprites[0];
        if (onlyOne && !s0.rotated && IsFullRect(s0, g.texW, g.texH))
        {
            // 整图单切图 -> Single 模式（Sprite 名 = 文件名；文件重命名后资产名可能 ≠ 切图名，
            // 由 g.singleSpriteName 兜底映射）
            importer.spriteImportMode = SpriteImportMode.Single;
            importer.spriteBorder = BorderVec(s0.border);
        }
        else
        {
            // 多切图 / 子矩形 / 含 rotated -> Multiple 模式，逐条 SpriteMetaData
            // rotated 切图不进图集 spritesheet（Unity 不支持原位旋转），改为像素级烘焙独立 Sprite。
            var metaList = new List<SpriteMetaData>();
            foreach (var s in g.sprites)
            {
                if (s.rotated) continue;
                var md = new SpriteMetaData();
                md.name = s.name;
                // 注: 本机 Unity(中国版 2022.3.62f3c1) 的 SpriteAlignment 在 UnityEngine 命名空间且
                // alignment 字段为 int；标准版为 UnityEditor.SpriteAlignment -> int，强转两者皆兼容。
                md.alignment = (int)SpriteAlignment.Center;
                md.border = BorderVec(s.border);
                // Cocos rect 的 y 自顶向下 -> Unity 自底向上
                float yUnity = g.texH - s.rect.y - s.rect.h;
                md.rect = new Rect(s.rect.x, yUnity, s.rect.w, s.rect.h);
                metaList.Add(md);
            }
            if (metaList.Count == 0)
            {
                // 全部切图都是 rotated: 图集本身无需切图，烘焙资产单独承载
                importer.spriteImportMode = SpriteImportMode.Single;
            }
            else
            {
                importer.spriteImportMode = SpriteImportMode.Multiple;
                // 注: 本机 Unity(中国版) 的属性名为 spritesheet，标准版为 sprites —— 反射赋值以兼容两者。
                var spriteListProp = typeof(TextureImporter).GetProperty("spritesheet")
                    ?? typeof(TextureImporter).GetProperty("sprites");
                if (spriteListProp == null)
                {
                    ctx.warnings.Add("TextureImporter 缺 sprites/spritesheet 属性，无法多重切图: " + g.assetPath);
                }
                else
                {
                    spriteListProp.SetValue(importer, metaList.ToArray(), null);
                }
            }
        }
        importer.SaveAndReimport();

        // 收集导入后的 Sprite（Single: 主资源即 Sprite；Multiple: 子资产按名收集）
        if (onlyOne && !s0.rotated && IsFullRect(s0, g.texW, g.texH))
        {
            var sp = AssetDatabase.LoadAssetAtPath<Sprite>(g.assetPath);
            if (sp != null)
            {
                g.loadedSprites[s0.name] = sp;
                g.singleSpriteName = s0.name;
            }
            else ctx.warnings.Add("Single 切图导入后未取到 Sprite: " + g.assetPath);
        }
        else if (!onlyOne || !s0.rotated)
        {
            foreach (var sp in AssetDatabase.LoadAllAssetsAtPath(g.assetPath).OfType<Sprite>())
                g.loadedSprites[sp.name] = sp;
        }

        // rotated 切图: 从拷贝的图集 PNG 提取转置块并逆时针旋转还原，烘焙为独立 Sprite
        foreach (var s in g.sprites)
        {
            if (!s.rotated) continue;
            var baked = BakeRotatedSprite(g, s, ctx.warnings);
            if (baked != null)
            {
                g.loadedSprites[s.name] = baked;
                g.bakedNames.Add(s.name);
            }
            else
            {
                ctx.warnings.Add("rotated 切图烘焙失败: " + s.name + " (源 " + Path.GetFileName(g.sourceAbs) + " rect " +
                    s.rect.x + "," + s.rect.y + "," + s.rect.w + "," + s.rect.h + ")");
            }
        }
    }

    /// <summary>按面板从共享组挑选 spriteMap（面板之间不串名），并统计 sprites/rotated/textureFiles 计数。</summary>
    static Dictionary<string, Sprite> BuildPanelSpriteMap(BuildEntry entry, BuildContext ctx)
    {
        var map = new Dictionary<string, Sprite>(StringComparer.Ordinal);
        var report = entry.EnsureReport(ctx);
        var seenGroups = new HashSet<TexGroup>();
        foreach (var g in entry.groups.List)
        {
            if (!seenGroups.Add(g)) continue;
            report.textureFiles++;
            if (g.singleSpriteName != null)
            {
                Sprite sp;
                if (g.loadedSprites.TryGetValue(g.singleSpriteName, out sp)) map[g.singleSpriteName] = sp;
                continue;
            }
            foreach (var kv in g.loadedSprites)
            {
                if (map.ContainsKey(kv.Key))
                    report.warnings.Add("面板内同名切图跨图集覆盖: " + kv.Key);
                map[kv.Key] = kv.Value;
            }
        }
        foreach (var s in entry.panelSprites)
        {
            report.spriteEntries++;
            if (map.ContainsKey(s.name))
            {
                report.spritesImported++;
                if (s.rotated && entry.groups.List.Any(g => g.bakedNames.Contains(s.name)))
                    report.rotatedBaked++;
            }
            else if (s.rotated)
            {
                report.rotatedSkipped++;
                report.warnings.Add("rotated 切图未就绪: " + s.name);
            }
            else
            {
                report.warnings.Add("切图导入后未解析到 Sprite: " + s.name);
            }
        }
        return map;
    }

    /// <summary>
    /// rotated 切图烘焙: 源数据实证 rect 为原始朝向尺寸（未裁边帧 rect.w/h == originalSize.w/h），
    /// 图集内物理块为转置 (bw=rect.h, bh=rect.w)，存储时顺时针旋转 90°。
    /// 从拷贝的图集 PNG（g.destAbs，绕过导入器压缩）提取该块并逆时针旋转还原，输出独立 Sprite。
    /// 注: 裁边帧（offset≠0）暂不回填透明边，切图保持裁后内容，节点 sizeDelta 仍用原始尺寸（轻微拉伸已记录为已知差异）。
    /// </summary>
    static Sprite BakeRotatedSprite(TexGroup g, SpriteDef s, List<string> warnings)
    {
        try
        {
            byte[] bytes = File.ReadAllBytes(g.destAbs);
            var srcTex = new Texture2D(2, 2, TextureFormat.RGBA32, false, false);
            if (!srcTex.LoadImage(bytes, false))
            {
                warnings.Add("rotated 源图解码失败: " + g.destAbs);
                return null;
            }
            int bw = Mathf.RoundToInt(s.rect.h);   // 图集物理块宽 = rect.h（转置）
            int bh = Mathf.RoundToInt(s.rect.w);   // 图集物理块高 = rect.w
            int px = Mathf.RoundToInt(s.rect.x);
            int py = srcTex.height - Mathf.RoundToInt(s.rect.y) - bh;  // Cocos y 顶左原点 -> Unity 底左原点
            if (bw <= 0 || bh <= 0 || px < 0 || py < 0 || px + bw > srcTex.width || py + bh > srcTex.height)
            {
                warnings.Add("rotated rect 越界或非法: " + s.name + " block " + bw + "x" + bh + " @ " + px + "," + py +
                    " (贴图 " + srcTex.width + "x" + srcTex.height + ")");
                return null;
            }
            var block = srcTex.GetPixels(px, py, bw, bh);

            // 逆时针旋转 90°: dst 尺寸 (bw2=bh, bh2=bw)；dst(x,y) <- src(srcY2=(Wd-1-x), srcX2=y)
            int wd = bh, hd = bw;
            var rotated = new Color[wd * hd];
            for (int y = 0; y < hd; y++)
                for (int x = 0; x < wd; x++)
                    rotated[y * wd + x] = block[(wd - 1 - x) * bw + y];

            var dstTex = new Texture2D(wd, hd, TextureFormat.RGBA32, false, false);
            dstTex.SetPixels(rotated);
            dstTex.Apply();
            var png = dstTex.EncodeToPNG();

            string dirAbs = Path.GetDirectoryName(g.destAbs);
            string fileName = "rot_" + C2UShared.SafeName(s.name) + ".png";
            string outAbs = Path.Combine(dirAbs ?? ".", fileName);
            File.WriteAllBytes(outAbs, png);
            string outAssetPath = g.assetPath.Substring(0, g.assetPath.LastIndexOf('/')) + "/" + fileName;

            var importer = AssetImporter.GetAtPath(outAssetPath) as TextureImporter;
            if (importer == null)
            {
                AssetDatabase.ImportAsset(outAssetPath);
                importer = AssetImporter.GetAtPath(outAssetPath) as TextureImporter;
            }
            if (importer == null)
            {
                warnings.Add("rotated 烘焙资产导入器获取失败: " + outAssetPath);
                return null;
            }
            importer.textureType = TextureImporterType.Sprite;
            importer.spriteImportMode = SpriteImportMode.Single;
            importer.spritePixelsPerUnit = 100f;
            importer.mipmapEnabled = false;
            importer.npotScale = TextureImporterNPOTScale.None;
            importer.alphaIsTransparency = true;
            importer.textureCompression = TextureImporterCompression.Uncompressed;
            importer.maxTextureSize = MaxSizeFor(wd, hd, warnings);
            importer.wrapMode = TextureWrapMode.Clamp;
            importer.spriteBorder = BorderVec(s.border);  // border 已是原始朝向 [L,B,R,T]
            importer.SaveAndReimport();

            var sp = AssetDatabase.LoadAssetAtPath<Sprite>(outAssetPath);
            if (sp == null)
            {
                warnings.Add("rotated 烘焙资产未取到 Sprite: " + outAssetPath);
                return null;
            }
            return sp;
        }
        catch (Exception e)
        {
            warnings.Add("rotated 烘焙异常: " + s.name + " - " + e.Message);
            return null;
        }
    }

    static bool IsFullRect(SpriteDef s, int tw, int th)
    {
        return s.rect.x <= 0.01f && s.rect.y <= 0.01f && s.rect.w >= tw - 0.01f && s.rect.h >= th - 0.01f;
    }

    static Vector4 BorderVec(float[] border)
    {
        if (border == null || border.Length < 4) return Vector4.zero;
        // 契约: border = [L,B,R,T]；Unity spriteBorder = (left, bottom, right, top)
        return new Vector4(border[0], border[1], border[2], border[3]);
    }

    static int MaxSizeFor(int w, int h, List<string> warnings)
    {
        int[] sizes = { 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192 };
        int need = Math.Max(w, h);
        foreach (var s in sizes) if (need <= s) return s;
        warnings.Add("贴图超过 8192 会被缩放导致切图偏移: " + w + "x" + h);
        return 8192;
    }

    // ---------------- stub 脚本生成 ----------------

    static bool GenerateStubScripts(BuildDef def, BuildContext ctx)
    {
        if (StripScripts || def.scripts == null) return false;
        string dirAbs = Path.Combine(C2UShared.ProjectRoot, GenScriptsDir.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(dirAbs);
        bool dirty = false;
        foreach (var s in def.scripts)
        {
            if (s == null || string.IsNullOrEmpty(s.className))
            {
                ctx.warnings.Add("scripts[] 条目缺 className: panel=" + def.meta.panel);
                continue;
            }
            string cls = SafeIdentifier(s.className);
            var sb = new StringBuilder();
            sb.AppendLine("// 本文件由 Cocos2UguiBuilder 自动生成，请勿手工编辑。");
            sb.AppendLine("// panel: " + def.meta.panel + "    cocos script uuidHash: " + s.uuidHash);
            sb.AppendLine();
            sb.AppendLine("using UnityEngine;");
            sb.AppendLine();
            sb.AppendLine("namespace " + StubNamespace);
            sb.AppendLine("{");
            sb.AppendLine("    public class " + cls + " : MonoBehaviour");
            sb.AppendLine("    {");
            if (s.fields != null)
            {
                foreach (var fd in s.fields)
                {
                    if (fd == null || string.IsNullOrEmpty(fd.name)) continue;
                    string fieldName = SafeIdentifier(fd.name);
                    string tooltip = (fd.tooltip ?? "").Replace("\"", "'").Replace("\r", " ").Replace("\n", " ");
                    sb.AppendLine("        [Tooltip(\"" + tooltip + "\")] public string " + fieldName + "; // cocosType: " + (fd.cocosType ?? ""));
                }
            }
            sb.AppendLine("    }");
            sb.AppendLine("}");
            string path = Path.Combine(dirAbs, cls + ".cs");
            string content = sb.ToString();
            bool exists = File.Exists(path);
            if (!exists || File.ReadAllText(path) != content)
            {
                File.WriteAllText(path, content, new UTF8Encoding(true));
                dirty = true;
            }
        }
        return dirty;
    }

    static string SafeIdentifier(string s)
    {
        var sb = new StringBuilder();
        foreach (char c in s)
        {
            bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
            sb.Append(ok ? c : '_');
        }
        string r = sb.ToString();
        if (r.Length == 0) r = "Stub";
        if (char.IsDigit(r[0])) r = "_" + r;
        return r;
    }

    // ---------------- 层级构建 ----------------

    static void BuildPanel(BuildEntry entry, BuildContext ctx)
    {
        var def = entry.def;
        var report = entry.EnsureReport(ctx);
        if (def.unmapped != null)
            foreach (var u in def.unmapped)
                if (u != null) report.unmapped.Add((u.node ?? "?") + " | " + (u.component ?? "?") + " | " + (u.reason ?? ""));

        // 临时 Canvas（CanvasScaler 750x1334 / match），面板挂其下再另存为 prefab
        var canvasGo = new GameObject("__c2u_canvas", typeof(Canvas), typeof(CanvasScaler));
        canvasGo.layer = 5;
        var scaler = canvasGo.GetComponent<CanvasScaler>();
        scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = new Vector2(def.meta.designResolution.width, def.meta.designResolution.height);
        scaler.screenMatchMode = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight;
        scaler.matchWidthOrHeight = def.meta.match;

        Dictionary<string, Sprite> spriteMap;
        if (!ctx.spriteMaps.TryGetValue(def.meta.panel, out spriteMap)) spriteMap = new Dictionary<string, Sprite>();

        var wirings = new List<ScrollWiring>();
        var panelGo = BuildNode(def.root, def, spriteMap, report, wirings);
        panelGo.transform.SetParent(canvasGo.transform, false);
        WireScrollContents(panelGo.transform, wirings);

        string prefabPath = PanelsDir + "/" + C2UShared.SafeName(def.meta.panel) + ".prefab";
        var saved = PrefabUtility.SaveAsPrefabAsset(panelGo, prefabPath);
        if (saved == null) throw new Exception("SaveAsPrefabAsset 返回 null: " + prefabPath);
        report.prefabPath = prefabPath;
        if (report.customDeferred > 0) ctx.deferredPrefabs[prefabPath] = report.deferredClassNames;

        UnityEngine.Object.DestroyImmediate(canvasGo);

        Debug.Log("[Cocos2Ugui] 面板完成 " + def.meta.panel + ": nodes=" + report.nodeCount
            + " sprites=" + report.spritesImported + "/" + report.spriteEntries
            + " rotated烘焙=" + report.rotatedBaked + " rotated跳过=" + report.rotatedSkipped + " markers=" + report.markerCount
            + " customScript=" + report.customAttached + "(挂载)/" + report.customDeferred + "(guid替换)"
            + " -> " + prefabPath);
    }

    static GameObject BuildNode(NodeDef node, BuildDef def, Dictionary<string, Sprite> spriteMap, PanelReport report, List<ScrollWiring> wirings)
    {
        if (node == null) node = new NodeDef();
        var go = new GameObject(string.IsNullOrEmpty(node.name) ? "node" : node.name, typeof(RectTransform));
        go.layer = 5; // UI
        var rt = (RectTransform)go.transform;
        ApplyRect(rt, node.rect ?? new RectProps());

        if (node.components != null)
        {
            foreach (var c in node.components)
            {
                if (c == null || string.IsNullOrEmpty(c.type)) continue;
                var props = c.props ?? new PropsDef();
                try { AddComponentByType(go, c.type, props, def, spriteMap, report, wirings); }
                catch (Exception e)
                {
                    report.warnings.Add("组件挂载失败 " + go.name + "/" + c.type + ": " + e.Message);
                    Debug.LogWarning("[Cocos2Ugui] 组件挂载失败 " + go.name + "/" + c.type + ": " + e);
                }
            }
        }

        if (node.children != null)
        {
            foreach (var child in node.children)
            {
                if (child == null) continue;
                var childGo = BuildNode(child, def, spriteMap, report, wirings);
                childGo.transform.SetParent(rt, false);
            }
        }

        go.SetActive(node.active);
        report.nodeCount++;
        return go;
    }

    /// <summary>rect 全部字段按契约直接赋值（P3 已完成换算）。锚点/pivot 先行，anchoredPosition/sizeDelta 次之，offsetMin/Max 最后。</summary>
    static void ApplyRect(RectTransform rt, RectProps r)
    {
        rt.anchorMin = ToV2(r.anchorMin, new Vector2(0.5f, 0.5f));
        rt.anchorMax = ToV2(r.anchorMax, new Vector2(0.5f, 0.5f));
        rt.pivot = ToV2(r.pivot, new Vector2(0.5f, 0.5f));
        rt.sizeDelta = ToV2(r.sizeDelta, Vector2.zero);
        rt.anchoredPosition = ToV2(r.anchoredPosition, Vector2.zero);
        rt.offsetMin = ToV2(r.offsetMin, Vector2.zero);
        rt.offsetMax = ToV2(r.offsetMax, Vector2.zero);
        rt.localRotation = Quaternion.Euler(0f, 0f, r.rotationZ);
        rt.localScale = ToV3(r.scale, Vector3.one);
    }

    static void AddComponentByType(GameObject go, string type, PropsDef props, BuildDef def,
        Dictionary<string, Sprite> spriteMap, PanelReport report, List<ScrollWiring> wirings)
    {
        switch (type)
        {
            case "Image":
            {
                var img = go.AddComponent<Image>();
                if (!string.IsNullOrEmpty(props.sprite))
                {
                    Sprite sp;
                    if (spriteMap.TryGetValue(props.sprite, out sp)) img.sprite = sp;
                    else report.warnings.Add("Image 引用的 sprite 未导入: '" + props.sprite + "' @ " + go.name);
                }
                img.type = ParseEnum(props.imageType, Image.Type.Simple);
                img.color = ToColor(props.color, Color.white);
                img.raycastTarget = props.raycastTarget;
                break;
            }
            case "Text":
            {
                var txt = go.AddComponent<Text>();
                txt.font = GetFont();
                txt.text = props.text ?? "";
                txt.fontSize = Mathf.Max(1, Mathf.RoundToInt(props.fontSize));
                txt.alignment = ParseEnum(props.alignment, TextAnchor.UpperLeft);
                // overflow 兼容 P3 可能透传的 Cocos 枚举:
                //   Overflow/None -> h=Overflow,v=Overflow; Wrap/Clamp/Shrink -> h=Wrap,v=Truncate;
                //   ResizeHeight -> h=Wrap,v=Overflow（UGUI 无自动增高，仅近似）
                string ov = (props.overflow ?? "Overflow").Trim();
                string ovKey = ov.ToLowerInvariant();
                HorizontalWrapMode hov; VerticalWrapMode vov;
                if (ovKey == "overflow" || ovKey == "none") { hov = HorizontalWrapMode.Overflow; vov = VerticalWrapMode.Overflow; }
                else if (ovKey == "wrap" || ovKey == "clamp" || ovKey == "shrink") { hov = HorizontalWrapMode.Wrap; vov = VerticalWrapMode.Truncate; }
                else if (ovKey == "resizeheight") { hov = HorizontalWrapMode.Wrap; vov = VerticalWrapMode.Overflow; }
                else
                {
                    hov = ParseEnum(ov, HorizontalWrapMode.Overflow);
                    vov = ParseEnum(ov, VerticalWrapMode.Overflow);
                }
                txt.horizontalOverflow = hov;
                txt.verticalOverflow = vov;
                txt.lineSpacing = props.lineSpacing;
                // 注: 本机 Unity(中国版) Text 无 richText，只有 supportRichText（标准版两者皆有）
                txt.supportRichText = props.richText;
                txt.color = ToColor(props.color, Color.white);
                break;
            }
            case "Button":
            {
                var btn = go.AddComponent<Button>();
                btn.interactable = props.interactable;
                btn.transition = ParseEnum(props.transition, Button.Transition.ColorTint);
                btn.targetGraphic = go.GetComponent<Graphic>();
                break;
            }
            case "Layout":
            {
                string lt = string.IsNullOrEmpty(props.layoutType) ? "Vertical" : props.layoutType;
                if (string.Equals(lt, "Grid", StringComparison.OrdinalIgnoreCase))
                {
                    var gl = go.AddComponent<GridLayoutGroup>();
                    gl.cellSize = new Vector2(100f, 100f);
                    gl.spacing = new Vector2(props.spacing, props.spacing);
                    gl.padding = ToRectOffset(props.padding);
                    gl.childAlignment = ParseEnum(props.childAlignment, TextAnchor.UpperLeft);
                }
                else
                {
                    HorizontalOrVerticalLayoutGroup lg = string.Equals(lt, "Horizontal", StringComparison.OrdinalIgnoreCase)
                        ? (HorizontalOrVerticalLayoutGroup)go.AddComponent<HorizontalLayoutGroup>()
                        : go.AddComponent<VerticalLayoutGroup>();
                    lg.spacing = props.spacing;
                    lg.padding = ToRectOffset(props.padding);
                    lg.childAlignment = ParseEnum(props.childAlignment, TextAnchor.UpperLeft);
                    bool control = string.Equals(props.resizeMode, "ControlSize", StringComparison.OrdinalIgnoreCase);
                    lg.childControlWidth = control;
                    lg.childControlHeight = control;
                    lg.childForceExpandWidth = false;
                    lg.childForceExpandHeight = false;
                }
                break;
            }
            case "RectMask2D":
                go.AddComponent<RectMask2D>();
                break;
            case "CanvasGroup":
            {
                var cg = go.AddComponent<CanvasGroup>();
                cg.alpha = props.alpha;
                cg.blocksRaycasts = props.blocksRaycasts;
                cg.interactable = true;
                break;
            }
            case "ScrollRect":
            {
                var sr = go.AddComponent<ScrollRect>();
                sr.horizontal = props.horizontal;
                sr.vertical = props.vertical;
                sr.movementType = ParseEnum(props.movementType, ScrollRect.MovementType.Elastic);
                if (!string.IsNullOrEmpty(props.content))
                    wirings.Add(new ScrollWiring { scrollRect = sr, host = go.transform, contentName = props.content });
                break;
            }
            case "CustomScript":
            {
                if (StripScripts) { report.strippedScripts++; break; }
                string uuidHash = props.script;
                ScriptDef scriptDef = (def.scripts ?? new ScriptDef[0]).FirstOrDefault(x => x != null && x.uuidHash == uuidHash);
                string clsName = scriptDef != null && !string.IsNullOrEmpty(scriptDef.className)
                    ? scriptDef.className
                    : "UnknownScript_" + (uuidHash ?? "null");
                var stubType = C2UShared.FindStubType(clsName);
                if (stubType != null)
                {
                    go.AddComponent(stubType);
                    report.customAttached++;
                }
                else
                {
                    // stub 本次运行尚未编译: 用 CocosMarker 占位（m_Script guid 随后替换为 stub 的 guid）
                    var ph = go.AddComponent<CocosMarker>();
                    ph.reason = CustomScriptMagic + clsName;
                    ph.source = "CustomScript:" + (uuidHash ?? "");
                    report.customDeferred++;
                    report.deferredClassNames.Add(clsName);
                    report.warnings.Add("CustomScript stub 未编译，已 guid 占位（下次运行或验证阶段生效）: " + clsName);
                }
                break;
            }
            case "Marker":
            {
                if (StripScripts) { report.strippedScripts++; break; }
                var mk = go.AddComponent<CocosMarker>();
                mk.reason = props.reason;
                mk.source = props.source;
                report.markerCount++;
                break;
            }
            default:
            {
                report.warnings.Add("未知组件类型 '" + type + "' @ " + go.name + "，降级为 Marker");
                var mk2 = go.AddComponent<CocosMarker>();
                mk2.reason = "unknown component type: " + type;
                mk2.source = type;
                report.markerCount++;
                break;
            }
        }
    }

    static void WireScrollContents(Transform root, List<ScrollWiring> wirings)
    {
        var all = root.GetComponentsInChildren<Transform>(true);
        foreach (var w in wirings)
        {
            var t = all.FirstOrDefault(x => x != null && x.name == w.contentName);
            if (t != null)
            {
                w.scrollRect.content = t as RectTransform;
                if (w.scrollRect.content == null)
                    Debug.LogWarning("[Cocos2Ugui] ScrollRect content 不是 RectTransform: " + w.contentName);
            }
            else
            {
                w.scrollRect.content = null;
                Debug.LogWarning("[Cocos2Ugui] ScrollRect content 节点未找到: " + w.contentName);
            }
        }
    }

    // ---------------- CustomScript guid 替换（首次运行未编译 stub 的兜底） ----------------

    static void ApplyCustomScriptGuidSwap(string prefabAssetPath, List<string> classNames, BuildContext ctx)
    {
        try
        {
            string abs = Path.Combine(C2UShared.ProjectRoot, prefabAssetPath.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(abs)) return;
            string text = File.ReadAllText(abs);
            int totalSwapped = 0;
            foreach (var cls in classNames.Distinct().ToList())
            {
                string magic = "reason: " + CustomScriptMagic + cls;
                int guard = 0;
                int idx;
                int searchFrom = 0;
                while ((idx = text.IndexOf(magic, searchFrom, StringComparison.Ordinal)) >= 0 && guard++ < 64)
                {
                    int blockStart = text.LastIndexOf("--- !u!114", idx, StringComparison.Ordinal);
                    if (blockStart < 0) break;
                    int nextBlock = text.IndexOf("\n--- !u!", idx, StringComparison.Ordinal);
                    int blockEnd = nextBlock < 0 ? text.Length : nextBlock + 1;
                    string guid = ReadMetaGuid("Assets/GeneratedScripts/" + SafeIdentifier(cls) + ".cs");
                    if (guid == null)
                    {
                        ctx.warnings.Add("未取到 stub .meta guid（跳过替换）: " + cls);
                        break;
                    }
                    string block = text.Substring(blockStart, blockEnd - blockStart);
                    string newBlock = Regex.Replace(block,
                        "(m_Script:\\s*\\{fileID:\\s*11500000,\\s*guid:\\s*)([0-9a-fA-F]{32})",
                        m => m.Groups[1].Value + guid);
                    if (newBlock == block)
                    {
                        // 该块已替换过（reason 标记仍保留）或无 m_Script：跳过继续找下一处
                        searchFrom = blockEnd;
                        continue;
                    }
                    text = text.Substring(0, blockStart) + newBlock + text.Substring(blockEnd);
                    totalSwapped++;
                    searchFrom = blockStart + newBlock.Length;
                }
            }
            if (totalSwapped > 0)
            {
                File.WriteAllText(abs, text);
                ctx.warnings.Add("prefab m_Script guid 替换 " + totalSwapped + " 处: " + prefabAssetPath
                    + "（stub 首次生成，下次运行起直接挂载）");
                foreach (var rep in ctx.panelReports)
                    if (rep.prefabPath == prefabAssetPath) rep.customGuidSwapped = totalSwapped;
            }
        }
        catch (Exception e)
        {
            ctx.warnings.Add("CustomScript guid 替换失败 " + prefabAssetPath + ": " + e.Message);
        }
    }

    static string ReadMetaGuid(string assetPath)
    {
        try
        {
            string metaAbs = Path.Combine(C2UShared.ProjectRoot, assetPath.Replace('/', Path.DirectorySeparatorChar)) + ".meta";
            if (!File.Exists(metaAbs)) return null;
            var m = Regex.Match(File.ReadAllText(metaAbs), "guid:\\s*([0-9a-f]{32})");
            return m.Success ? m.Groups[1].Value : null;
        }
        catch { return null; }
    }

    // ---------------- 小工具 ----------------

    static void EnsureFolder(string assetFolder)
    {
        var parts = assetFolder.Split('/');
        string cur = parts[0];
        for (int i = 1; i < parts.Length; i++)
        {
            string next = cur + "/" + parts[i];
            if (!AssetDatabase.IsValidFolder(next)) AssetDatabase.CreateFolder(cur, parts[i]);
            cur = next;
        }
    }

    static T ParseEnum<T>(string s, T fallback) where T : struct
    {
        if (string.IsNullOrEmpty(s)) return fallback;
        T v;
        if (Enum.TryParse<T>(s, true, out v)) return v;
        Debug.LogWarning("[Cocos2Ugui] 枚举值无法识别 '" + s + "'，使用默认 " + fallback + " (" + typeof(T).Name + ")");
        return fallback;
    }

    static Vector2 ToV2(float[] a, Vector2 fallback)
    {
        if (a == null || a.Length < 2) return fallback;
        return new Vector2(a[0], a[1]);
    }

    static Vector3 ToV3(float[] a, Vector3 fallback)
    {
        if (a == null || a.Length < 3) return fallback;
        return new Vector3(a[0], a[1], a[2]);
    }

    static Color ToColor(float[] a, Color fallback)
    {
        if (a == null || a.Length < 4) return fallback;
        return new Color(
            Mathf.Clamp01(a[0]), Mathf.Clamp01(a[1]), Mathf.Clamp01(a[2]), Mathf.Clamp01(a[3]));
    }

    static RectOffset ToRectOffset(float[] p)
    {
        if (p == null || p.Length < 4) return new RectOffset();
        // 契约 padding = [L,B,R,T]（与 border 约定一致）；RectOffset 构造为 (left, right, top, bottom)
        return new RectOffset(Mathf.RoundToInt(p[0]), Mathf.RoundToInt(p[2]), Mathf.RoundToInt(p[3]), Mathf.RoundToInt(p[1]));
    }

    static Font _font;
    static Font GetFont()
    {
        if (_font == null)
        {
            try { _font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf"); } catch { }
            if (_font == null)
            {
                try { _font = Resources.GetBuiltinResource<Font>("Arial.ttf"); } catch { }
            }
        }
        return _font;
    }

    static string Hash8(string s)
    {
        using (var md5 = MD5.Create())
        {
            byte[] h = md5.ComputeHash(Encoding.UTF8.GetBytes(s ?? ""));
            var sb = new StringBuilder(16);
            for (int i = 0; i < 4; i++) sb.Append(h[i].ToString("x2"));
            return sb.ToString();
        }
    }

    static void WriteBuildReport(BuildContext ctx)
    {
        string reportDir = C2UShared.GetArg("reportDir") ?? Path.Combine(C2UShared.ProjectRoot, "Reports");
        string path = ctx.ReportPath("build-report.json");
        var root = new Dictionary<string, object>
        {
            { "tool", "Cocos2UguiBuilder" },
            { "unityVersion", Application.unityVersion },
            { "generatedAt", DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") },
            { "panels", ctx.panelReports.Select(r => (object)r.ToDict()).ToList() },
            { "warnings", ctx.warnings.ToList() },
            { "failures", ctx.fatal.ToList() },
        };
        C2UShared.WriteTextFile(path, C2UShared.ToJson(root));
    }

    // ---------------- 内部类型 ----------------

    class BuildEntry
    {
        public string buildPath;
        public BuildDef def;
        public TexGroupList groups = new TexGroupList();   // 本面板引用的共享组（元素可能跨面板共享）
        public List<SpriteDef> panelSprites = new List<SpriteDef>();  // 本面板的切图引用清单（计数用）
        PanelReport _report;
        public PanelReport EnsureReport(BuildContext ctx)
        {
            if (_report == null)
            {
                _report = new PanelReport { panel = def.meta.panel, buildFile = buildPath };
                ctx.panelReports.Add(_report);
            }
            return _report;
        }
    }

    internal class TexGroup
    {
        public string sourceAbs;
        public string destAbs;
        public string assetPath;
        public int texW, texH;
        public List<SpriteDef> sprites = new List<SpriteDef>();  // 全部引用面板的并集（去重后）
        // 共享库: 导入结果挂在组上，各面板按名挑选
        public Dictionary<string, Sprite> loadedSprites = new Dictionary<string, Sprite>(StringComparer.Ordinal);
        public HashSet<string> bakedNames = new HashSet<string>(StringComparer.Ordinal);
        public string singleSpriteName;   // Single 模式下切图定义名（文件重命名后资产名可能不同）
    }

    class TexGroupList
    {
        public List<TexGroup> List = new List<TexGroup>();
        public bool Dirty;
    }

    class ScrollWiring
    {
        public ScrollRect scrollRect;
        public Transform host;
        public string contentName;
    }
}

public class PanelReport
{
    public string panel;
    public string buildFile;
    public string prefabPath;
    public int nodeCount;
    public int spriteEntries;
    public int textureFiles;
    public int spritesImported;
    public int rotatedSkipped;
    public int rotatedBaked;
    public int strippedScripts;
    public int markerCount;
    public int customAttached;
    public int customDeferred;
    public int customGuidSwapped;
    public List<string> deferredClassNames = new List<string>();
    public List<string> warnings = new List<string>();
    public List<string> unmapped = new List<string>();

    public Dictionary<string, object> ToDict()
    {
        return new Dictionary<string, object>
        {
            { "panel", panel },
            { "buildFile", buildFile },
            { "prefabPath", prefabPath },
            { "nodeCount", nodeCount },
            { "spriteEntries", spriteEntries },
            { "textureFilesImported", textureFiles },
            { "spritesImported", spritesImported },
            { "rotatedSkipped", rotatedSkipped },
            { "rotatedBaked", rotatedBaked },
            { "strippedScripts", strippedScripts },
            { "markerCount", markerCount },
            { "customScriptAttached", customAttached },
            { "customScriptDeferredGuidSwap", customDeferred },
            { "warnings", warnings.ToList() },
            { "unmapped", unmapped.ToList() },
        };
    }
}

class BuildContext
{
    public List<string> warnings = new List<string>();
    public List<string> fatal = new List<string>();
    public List<PanelReport> panelReports = new List<PanelReport>();
    public Dictionary<string, Dictionary<string, Sprite>> spriteMaps = new Dictionary<string, Dictionary<string, Sprite>>();
    // 共享贴图库状态（TexGroup 在 Cocos2Ugui 命名空间内，此处全限定）
    public Dictionary<string, Cocos2UguiBuilder.TexGroup> groupBySource = new Dictionary<string, Cocos2UguiBuilder.TexGroup>(StringComparer.OrdinalIgnoreCase);
    public List<Cocos2UguiBuilder.TexGroup> globalGroups = new List<Cocos2UguiBuilder.TexGroup>();
    public HashSet<string> libFileNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, List<string>> deferredPrefabs = new Dictionary<string, List<string>>();

    public string ReportPath(string fileName)
    {
        string dir = C2UShared.GetArg("reportDir");
        if (string.IsNullOrEmpty(dir)) dir = Path.Combine(C2UShared.ProjectRoot, "Reports");
        return Path.Combine(dir, fileName);
    }

    public List<string> SummaryLines()
    {
        var lines = new List<string>();
        foreach (var r in panelReports)
            lines.Add("面板 " + r.panel + ": nodes=" + r.nodeCount
                + " sprites=" + r.spritesImported + "/" + r.spriteEntries
                + " rotated烘焙=" + r.rotatedBaked + " rotated跳过=" + r.rotatedSkipped
                + " markers=" + r.markerCount
                + " customScript=" + r.customAttached + "+" + r.customDeferred + "(guid)");
        return lines;
    }
}
