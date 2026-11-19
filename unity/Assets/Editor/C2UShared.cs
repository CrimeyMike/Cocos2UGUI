// C2UShared.cs — Cocos2Ugui 流水线共享层：build.json DTO、命令行参数、构建文件发现、
// 图片头解析、stub 类型查找、极简 JSON 序列化。供 Cocos2UguiBuilder / PrefabVerifier /
// PanelCapture 三个工具共用。契约见 cocos2ugui/BUILD-SCHEMA.md。
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using UnityEngine;

// ---------- build.json DTO（字段名即契约字段名；缺省字段保持初始化默认值） ----------

[Serializable]
public class BuildMeta
{
    public string panel;
    public string bundle;
    public DesignRes designResolution;
    public float match = 1f;
    public string generatedBy;
    public string[] flags;
}

[Serializable]
public class DesignRes { public int width = 750; public int height = 1334; }

[Serializable]
public class RectDef { public float x, y, w, h; }

[Serializable]
public class SpriteDef
{
    public string name;
    public string source;
    public RectDef rect;
    public bool rotated;
    public float[] border;      // [L,B,R,T]，无则 null
}

[Serializable]
public class ScriptFieldDef { public string name; public string cocosType; public string tooltip; }

[Serializable]
public class ScriptDef
{
    public string uuidHash;
    public string className;
    public ScriptFieldDef[] fields;
}

[Serializable]
public class RectProps
{
    public float[] anchorMin = new float[] { 0.5f, 0.5f };
    public float[] anchorMax = new float[] { 0.5f, 0.5f };
    public float[] offsetMin = new float[] { -375f, -667f };
    public float[] offsetMax = new float[] { 375f, 667f };
    public float[] pivot = new float[] { 0.5f, 0.5f };
    public float[] anchoredPosition = new float[] { 0f, 0f };
    public float[] sizeDelta = new float[] { 750f, 1334f };
    public float rotationZ = 0f;
    public float[] scale = new float[] { 1f, 1f, 1f };
}

[Serializable]
public class PropsDef
{
    // Image
    public string sprite;
    public string imageType = "Simple";
    public float[] color = new float[] { 1f, 1f, 1f, 1f };
    public bool raycastTarget = true;
    // Text
    public string text = "";
    public float fontSize = 28f;
    public string alignment = "UpperLeft";
    public string overflow = "Overflow";
    public float lineSpacing = 1f;
    public bool richText = true;
    // Button
    public bool interactable = true;
    public string transition = "ColorTint";
    // Layout
    public string layoutType = "Vertical";
    public float spacing = 0f;
    public float[] padding = new float[] { 0f, 0f, 0f, 0f };  // [L,B,R,T]，与 border 约定一致
    public string childAlignment = "UpperLeft";
    public string resizeMode = "ControlSize";
    // CanvasGroup (UIOpacity 映射)
    public float alpha = 1f;
    public bool blocksRaycasts = true;
    // ScrollRect
    public string content;
    public bool horizontal = false;
    public bool vertical = true;
    public string movementType = "Elastic";
    // CustomScript / Marker
    public string script;
    public string reason;
    public string source;
}

[Serializable]
public class ComponentDef { public string type; public PropsDef props; }

[Serializable]
public class NodeDef
{
    public string name;
    public bool active = true;
    public RectProps rect;
    public ComponentDef[] components;
    public NodeDef[] children;
}

[Serializable]
public class UnmappedDef { public string node; public string component; public string reason; }

[Serializable]
public class BuildDef
{
    public BuildMeta meta;
    public SpriteDef[] sprites;
    public ScriptDef[] scripts;
    public NodeDef root;
    public UnmappedDef[] unmapped;
}

// ---------- 共享工具 ----------

public static class C2UShared
{
    public static string ProjectRoot
    {
        get { return Path.GetFullPath(Path.Combine(Application.dataPath, "..")); }
    }

    public static bool InBatchMode
    {
        get
        {
            var args = Environment.GetCommandLineArgs();
            foreach (var a in args) if (string.Equals(a, "-batchmode", StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }
    }

    public static string GetArg(string name)
    {
        var args = Environment.GetCommandLineArgs();
        for (int i = 0; i < args.Length - 1; i++)
            if (string.Equals(args[i], "-" + name, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
        return null;
    }

    /// <summary>查找 build.json：-buildDir 参数 &gt; C2U_BUILD_DIR 环境变量 &gt;
    /// cocos2ugui/build(项目根上两级) 与 cocos2ugui/unity/build(上一级)；StreamingAssets/builds 样例目录恒纳入。</summary>
    public static List<string> FindBuildFiles(List<string> warnings)
    {
        var files = new List<string>();
        string explicitDir = GetArg("buildDir");
        if (string.IsNullOrEmpty(explicitDir)) explicitDir = Environment.GetEnvironmentVariable("C2U_BUILD_DIR");
        if (!string.IsNullOrEmpty(explicitDir))
        {
            if (Directory.Exists(explicitDir)) AddAll(explicitDir, files);
            else warnings.Add("指定的 buildDir 不存在: " + explicitDir);
        }
        else
        {
            string p3 = Path.GetFullPath(Path.Combine(ProjectRoot, "..", "..", "build"));   // cocos2ugui/build
            string pAlt = Path.GetFullPath(Path.Combine(ProjectRoot, "..", "build"));       // cocos2ugui/unity/build
            if (Directory.Exists(p3)) AddAll(p3, files);
            if (Directory.Exists(pAlt)) AddAll(pAlt, files);
        }
        string samples = Path.Combine(Application.dataPath, "StreamingAssets", "builds");
        if (Directory.Exists(samples)) AddAll(samples, files);

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<string>();
        foreach (var f in files)
        {
            string full = Path.GetFullPath(f);
            if (seen.Add(full)) result.Add(full);
        }
        return result;
    }

    static void AddAll(string dir, List<string> files)
    {
        try { files.AddRange(Directory.GetFiles(dir, "*.build.json")); }
        catch { }
    }

    public static BuildDef LoadBuild(string path)
    {
        string json = File.ReadAllText(path);
        BuildDef def = JsonUtility.FromJson<BuildDef>(json);
        if (def == null) throw new Exception("JsonUtility 解析失败: " + path);
        if (def.meta == null) def.meta = new BuildMeta();
        if (string.IsNullOrEmpty(def.meta.panel))
            def.meta.panel = Path.GetFileNameWithoutExtension(path).Replace(".build", "");
        if (def.meta.designResolution == null) def.meta.designResolution = new DesignRes();
        return def;
    }

    /// <summary>sprites[].source 支持绝对路径（P3 契约）与相对路径（相对 build.json 所在目录）。</summary>
    public static string ResolveSource(string source, string buildJsonPath)
    {
        if (string.IsNullOrEmpty(source)) return null;
        if (Path.IsPathRooted(source)) return source;
        return Path.GetFullPath(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(buildJsonPath)), source));
    }

    /// <summary>资产名/文件名安全化：仅保留 [A-Za-z0-9_-]。</summary>
    public static string SafeName(string s)
    {
        if (string.IsNullOrEmpty(s)) return "unnamed";
        var sb = new StringBuilder(s.Length);
        foreach (char c in s)
        {
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-')
                sb.Append(c);
            else sb.Append('_');
        }
        if (sb.Length == 0) return "unnamed";
        if (char.IsDigit(sb[0])) sb.Insert(0, '_');
        return sb.ToString();
    }

    /// <summary>查找已编译的生成 stub 类型（命名空间 Cocos2Ugui.Generated）。未编译或不存在返回 null。</summary>
    public static Type FindStubType(string className)
    {
        if (string.IsNullOrEmpty(className)) return null;
        // builder 侧 stub 类名经 SafeIdentifier 清洗（非法字符→'_'、数字开头加'_'前缀），按同规则兜底
        string safe = System.Text.RegularExpressions.Regex.Replace(className, "[^0-9A-Za-z_]", "_");
        if (safe.Length > 0 && !char.IsLetter(safe[0]) && safe[0] != '_') safe = "_" + safe;
        return FindStubTypeCore(className) ?? FindStubTypeCore(safe);
    }

    static Type FindStubTypeCore(string className)
    {
        if (string.IsNullOrEmpty(className)) return null;
        string full = "Cocos2Ugui.Generated." + className;
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            Type t = null;
            try { t = asm.GetType(full, false); } catch { }
            if (t != null && typeof(MonoBehaviour).IsAssignableFrom(t)) return t;
        }
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            Type[] types = null;
            try { types = asm.GetTypes(); } catch { continue; }
            foreach (var t in types)
                if (t != null && t.Name == className && typeof(MonoBehaviour).IsAssignableFrom(t)) return t;
        }
        return null;
    }

    // ---------- 图片头解析（PNG IHDR / JPEG SOFn），用于 Cocos→Unity rect 的 y 轴换算 ----------

    public static bool TryReadImageSize(string path, out int w, out int h)
    {
        w = 0; h = 0;
        try
        {
            using (var fs = File.OpenRead(path))
            {
                var b = new byte[8];
                if (fs.Read(b, 0, 8) != 8) return false;
                if (b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47)
                {
                    // PNG: 签名8 + 长度4 + 类型4 + 宽4 + 高4（大端）
                    var ih = new byte[16];
                    if (fs.Read(ih, 0, 16) != 16) return false;
                    w = (ih[8] << 24) | (ih[9] << 16) | (ih[10] << 8) | ih[11];
                    h = (ih[12] << 24) | (ih[13] << 16) | (ih[14] << 8) | ih[15];
                    return w > 0 && h > 0;
                }
                if (b[0] == 0xFF && b[1] == 0xD8)
                {
                    // JPEG: 扫描 SOF 标记
                    while (true)
                    {
                        int m = fs.ReadByte();
                        if (m < 0) return false;
                        if (m != 0xFF) continue;
                        int marker = fs.ReadByte();
                        if (marker < 0) return false;
                        while (marker == 0xFF) marker = fs.ReadByte();
                        if (marker == 0xD8 || marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue;
                        var lenb = new byte[2];
                        if (fs.Read(lenb, 0, 2) != 2) return false;
                        int len = (lenb[0] << 8) | lenb[1];
                        bool isSof = marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC;
                        if (isSof)
                        {
                            var sof = new byte[5]; // precision(1) height(2) width(2)
                            if (fs.Read(sof, 0, 5) != 5) return false;
                            h = (sof[1] << 8) | sof[2];
                            w = (sof[3] << 8) | sof[4];
                            return w > 0 && h > 0;
                        }
                        fs.Seek(len - 2, SeekOrigin.Current);
                    }
                }
            }
        }
        catch { }
        return false;
    }

    // ---------- 极简 JSON 序列化（避免第三方依赖；支持 Dictionary/List/基元） ----------

    public static string ToJson(object o)
    {
        var sb = new StringBuilder();
        JsonSerialize(o, sb);
        return sb.ToString();
    }

    static void JsonSerialize(object o, StringBuilder sb)
    {
        if (o == null) { sb.Append("null"); return; }
        if (o is string) { sb.Append(JsonEscape((string)o)); return; }
        if (o is bool) { sb.Append(((bool)o) ? "true" : "false"); return; }
        if (o is byte || o is short || o is int || o is long) { sb.Append(((IConvertible)o).ToString(CultureInfo.InvariantCulture)); return; }
        if (o is float || o is double || o is decimal)
        {
            double d = Convert.ToDouble(o, CultureInfo.InvariantCulture);
            if (double.IsInfinity(d) || double.IsNaN(d)) { sb.Append("null"); return; }
            sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
            return;
        }
        if (o is Vector2) { var v = (Vector2)o; JsonSerialize(new List<object> { v.x, v.y }, sb); return; }
        if (o is Vector3) { var v = (Vector3)o; JsonSerialize(new List<object> { v.x, v.y, v.z }, sb); return; }
        // 注意: IDictionary 也是 IEnumerable，必须先判字典再判可枚举
        var dictFirst = o as IDictionary;
        if (dictFirst != null)
        {
            sb.Append('{');
            bool firstKv = true;
            foreach (DictionaryEntry kv in dictFirst)
            {
                if (!firstKv) sb.Append(',');
                firstKv = false;
                sb.Append(JsonEscape(Convert.ToString(kv.Key, CultureInfo.InvariantCulture))).Append(':');
                JsonSerialize(kv.Value, sb);
            }
            sb.Append('}');
            return;
        }
        if (o is IEnumerable)
        {
            sb.Append('[');
            bool first = true;
            foreach (var v in (IEnumerable)o)
            {
                if (!first) sb.Append(',');
                first = false;
                JsonSerialize(v, sb);
            }
            sb.Append(']');
            return;
        }
        // 普通对象 -> public 字段
        sb.Append('{');
        bool f = true;
        foreach (var fi in o.GetType().GetFields())
        {
            if (!fi.IsPublic) continue;
            if (!f) sb.Append(',');
            f = false;
            sb.Append(JsonEscape(fi.Name)).Append(':');
            JsonSerialize(fi.GetValue(o), sb);
        }
        sb.Append('}');
    }

    static string JsonEscape(string s)
    {
        if (string.IsNullOrEmpty(s)) return "\"\"";
        var sb = new StringBuilder(s.Length + 8);
        sb.Append('"');
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    public static void WriteTextFile(string absPath, string content)
    {
        string dir = Path.GetDirectoryName(absPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        File.WriteAllText(absPath, content, new UTF8Encoding(false));
    }
}
