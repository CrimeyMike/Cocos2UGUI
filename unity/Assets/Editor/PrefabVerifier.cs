// PrefabVerifier.cs — P4 验证器：重读 Assets/Panels 下生成的 prefab，与 build.json 逐字段 diff
// （节点名 / active / rect 全字段 / 组件存在性 / Image.sprite 非空 / Text.text / ScrollRect.content），
// 输出 Reports/verification-report.json。batchmode 下 diff != 0 时以退出码 2 结束。
//
// batchmode 入口:
//   Unity.exe -batchmode -quit -projectPath <proj> -executeMethod PrefabVerifier.VerifyAll
// 可选: -buildDir <dir>（限定输入目录）、-reportDir <dir>
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;

public static class PrefabVerifier
{
    const float Eps = 0.05f;

    [MenuItem("Tools/Cocos2Ugui/2. Verify Prefabs")]
    public static void VerifyAll()
    {
        bool allOk = true;
        var warnings = new List<string>();
        var files = C2UShared.FindBuildFiles(warnings);
        var panels = new List<object>();

        if (files.Count == 0) Debug.LogWarning("[C2UVerify] 未找到任何 *.build.json");
        var panelSeen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var f in files)
        {
            BuildDef def;
            try { def = C2UShared.LoadBuild(f); }
            catch (Exception e)
            {
                panels.Add(new Dictionary<string, object> { { "panel", Path.GetFileName(f) }, { "ok", false }, { "diffs", new List<object> { "build.json 解析失败: " + e.Message } } });
                allOk = false;
                continue;
            }
            if (!panelSeen.Add(def.meta.panel)) continue;
            var result = VerifyPanel(def, f);
            panels.Add(result);
            bool ok = (bool)result["ok"];
            if (!ok) allOk = false;
            Debug.Log("[C2UVerify] " + def.meta.panel + ": " + (ok ? "PASS diff=0" : "FAIL diff=" + ((List<object>)result["diffs"]).Count)
                + " nodes=" + result["nodesChecked"] + " markers=" + result["markerCount"]);
            foreach (var d in (List<object>)result["diffs"])
                Debug.LogError("[C2UVerify] " + def.meta.panel + " | " + d);
        }

        string reportDir = C2UShared.GetArg("reportDir") ?? Path.Combine(C2UShared.ProjectRoot, "Reports");
        string reportPath = Path.Combine(reportDir, "verification-report.json");
        var root = new Dictionary<string, object>
        {
            { "tool", "PrefabVerifier" },
            { "unityVersion", Application.unityVersion },
            { "generatedAt", DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") },
            { "allOk", allOk },
            { "panels", panels },
            { "warnings", warnings },
        };
        C2UShared.WriteTextFile(reportPath, C2UShared.ToJson(root));
        Debug.Log("[C2UVerify] 验证 " + (allOk ? "全部通过" : "存在差异") + "，报告: " + reportPath);

        if (!allOk && C2UShared.InBatchMode)
            EditorApplication.Exit(2);
    }

    static Dictionary<string, object> VerifyPanel(BuildDef def, string buildPath)
    {
        string panel = def.meta.panel;
        var diffs = new List<object>();
        string prefabPath = "Assets/Panels/" + C2UShared.SafeName(panel) + ".prefab";
        var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
        if (prefab == null)
        {
            diffs.Add("prefab 不存在: " + prefabPath);
            return Result(panel, prefabPath, false, 0, 0, 0, diffs);
        }

        int nodesChecked = 0;
        if (def.root == null)
        {
            diffs.Add("build.json 缺 root");
        }
        else
        {
            CompareNode(prefab.transform, def.root, def, diffs, ref nodesChecked, true);
        }
        int markerCount = prefab.GetComponentsInChildren<CocosMarker>(true).Length;
        int expectedMarkers = CountExpectedMarkers(def.root);
        var notes = diffs.Where(d => ((string)d).StartsWith("INFO:", StringComparison.Ordinal)).ToList();
        var realDiffs = diffs.Where(d => !((string)d).StartsWith("INFO:", StringComparison.Ordinal)).ToList();
        var result = Result(panel, prefabPath, realDiffs.Count == 0, nodesChecked, markerCount, expectedMarkers, realDiffs);
        result["notes"] = notes;
        return result;
    }

    static Dictionary<string, object> Result(string panel, string prefabPath, bool ok, int nodesChecked, int markerCount, int expectedMarkers, List<object> diffs)
    {
        return new Dictionary<string, object>
        {
            { "panel", panel },
            { "prefabPath", prefabPath },
            { "ok", ok },
            { "nodesChecked", nodesChecked },
            { "markerCount", markerCount },
            { "markerCountExpected", expectedMarkers },
            { "diffs", diffs },
        };
    }

    static int CountExpectedMarkers(NodeDef node)
    {
        if (node == null) return 0;
        int n = (node.components ?? new ComponentDef[0]).Count(c => c != null && c.type == "Marker");
        foreach (var ch in (node.children ?? new NodeDef[0])) n += CountExpectedMarkers(ch);
        return n;
    }

    static void CompareNode(Transform t, NodeDef n, BuildDef def, List<object> diffs, ref int nodesChecked, bool isRoot = false)
    {
        nodesChecked++;
        string path = NodePath(t);

        if (t.name != n.name)
        {
            // Unity 规则: SaveAsPrefabAsset 会把 prefab 根 GameObject 重命名为资产文件名（= panel 名）。
            // 根节点名允许 == panel 名；其余层级名称必须与 build.json 完全一致。
            if (isRoot && (t.name == def.meta.panel || t.name == C2UShared.SafeName(def.meta.panel)))
                diffs.Add("INFO: 根节点名按 Unity 资产名规则映射，期望 '" + n.name + "' 实际 '" + t.name + "'（非差异）");
            else
                diffs.Add(path + ": 节点名期望 '" + n.name + "' 实际 '" + t.name + "'");
        }
        if (t.gameObject.activeSelf != n.active)
            diffs.Add(path + ": active 期望 " + n.active + " 实际 " + t.gameObject.activeSelf);

        var rt = t as RectTransform;
        var r = n.rect ?? new RectProps();
        if (rt == null)
        {
            diffs.Add(path + ": 缺 RectTransform");
        }
        else
        {
            CmpV2(path, "anchorMin", rt.anchorMin, r.anchorMin, new float[] { 0.5f, 0.5f }, diffs);
            CmpV2(path, "anchorMax", rt.anchorMax, r.anchorMax, new float[] { 0.5f, 0.5f }, diffs);
            CmpV2(path, "offsetMin", rt.offsetMin, r.offsetMin, null, diffs);
            CmpV2(path, "offsetMax", rt.offsetMax, r.offsetMax, null, diffs);
            CmpV2(path, "pivot", rt.pivot, r.pivot, new float[] { 0.5f, 0.5f }, diffs);
            CmpV2(path, "anchoredPosition", rt.anchoredPosition, r.anchoredPosition, new float[] { 0f, 0f }, diffs);
            CmpV2(path, "sizeDelta", rt.sizeDelta, r.sizeDelta, null, diffs);
            float rz = rt.localEulerAngles.z;
            float want = r.rotationZ;
            float d = Mathf.Abs(rz - want);
            d = Mathf.Min(d, Mathf.Abs(d - 360f)); // 欧拉角 360 环绕
            if (d > Eps) diffs.Add(path + ": rotationZ 期望 " + want + " 实际 " + rz);
            var sc = rt.localScale;
            var wsc = (r.scale != null && r.scale.Length >= 3) ? r.scale : new float[] { 1f, 1f, 1f };
            if (Mathf.Abs(sc.x - wsc[0]) > Eps || Mathf.Abs(sc.y - wsc[1]) > Eps || Mathf.Abs(sc.z - wsc[2]) > Eps)
                diffs.Add(path + ": scale 期望 [" + wsc[0] + "," + wsc[1] + "," + wsc[2] + "] 实际 [" + sc.x + "," + sc.y + "," + sc.z + "]");
        }

        // 组件存在性
        foreach (var c in (n.components ?? new ComponentDef[0]))
        {
            if (c == null || string.IsNullOrEmpty(c.type)) continue;
            var props = c.props ?? new PropsDef();
            switch (c.type)
            {
                case "Image":
                {
                    var img = t.GetComponent<Image>();
                    if (img == null) diffs.Add(path + ": 缺 Image");
                    else if (!string.IsNullOrEmpty(props.sprite) && img.sprite == null)
                        diffs.Add(path + ": Image.sprite 为 null（期望切图 '" + props.sprite + "'）");
                    break;
                }
                case "Text":
                {
                    var txt = t.GetComponent<Text>();
                    if (txt == null) diffs.Add(path + ": 缺 Text");
                    else if ((txt.text ?? "") != (props.text ?? ""))
                        diffs.Add(path + ": Text.text 期望 \"" + props.text + "\" 实际 \"" + txt.text + "\"");
                    break;
                }
                case "Button":
                    if (t.GetComponent<Button>() == null) diffs.Add(path + ": 缺 Button");
                    break;
                case "Layout":
                {
                    bool has = t.GetComponent<HorizontalOrVerticalLayoutGroup>() != null || t.GetComponent<GridLayoutGroup>() != null;
                    if (!has) diffs.Add(path + ": 缺 LayoutGroup (layoutType=" + props.layoutType + ")");
                    break;
                }
                case "RectMask2D":
                    if (t.GetComponent<RectMask2D>() == null) diffs.Add(path + ": 缺 RectMask2D");
                    break;
                case "CanvasGroup":
                    if (t.GetComponent<CanvasGroup>() == null) diffs.Add(path + ": 缺 CanvasGroup");
                    break;
                case "ScrollRect":
                {
                    var sr = t.GetComponent<ScrollRect>();
                    if (sr == null) diffs.Add(path + ": 缺 ScrollRect");
                    else if (!string.IsNullOrEmpty(props.content) && sr.content == null)
                        diffs.Add(path + ": ScrollRect.content 为 null（期望 '" + props.content + "'）");
                    break;
                }
                case "CustomScript":
                {
                    if (!string.IsNullOrEmpty(C2UShared.GetArg("stripScripts"))) break; // P7: 剥离模式下 prefab 无任何自定义组件
                    string clsName = "UnknownScript_" + (props.script ?? "null");
                    string safeCls = System.Text.RegularExpressions.Regex.Replace(clsName, "[^0-9A-Za-z_]", "_");
                    var scriptDef = (def.scripts ?? new ScriptDef[0]).FirstOrDefault(x => x != null && x.uuidHash == props.script);
                    if (scriptDef != null && !string.IsNullOrEmpty(scriptDef.className)) clsName = scriptDef.className;
                    var stubType = C2UShared.FindStubType(clsName);
                    bool found = false;
                    if (stubType != null) found = t.GetComponent(stubType) != null;
                    if (!found)
                    {
                        foreach (var mb in t.GetComponents<MonoBehaviour>())
                            if (mb != null && (mb.GetType().Name == clsName || mb.GetType().Name == safeCls)) { found = true; break; }
                    }
                    if (!found)
                    {
                        if (clsName.StartsWith("UnknownScript_"))
                            diffs.Add("待补: 未解析脚本 uuid=" + (props.script ?? "null") + " @ " + path + "（静态数据无类名映射，保留占位组件）");
                        else
                            diffs.Add(path + ": 缺 CustomScript stub (" + clsName + ")");
                    }
                    break;
                }
                case "Marker":
                    if (!string.IsNullOrEmpty(C2UShared.GetArg("stripScripts"))) break;
                    if (t.GetComponent<CocosMarker>() == null) diffs.Add(path + ": 缺 CocosMarker (Marker)");
                    break;
                default:
                    diffs.Add(path + ": build.json 含未知组件类型 '" + c.type + "'");
                    break;
            }
        }

        // 子节点
        int wantChildren = (n.children ?? new NodeDef[0]).Length;
        if (wantChildren != t.childCount)
        {
            diffs.Add(path + ": 子节点数期望 " + wantChildren + " 实际 " + t.childCount);
        }
        else
        {
            var children = n.children ?? new NodeDef[0];
            for (int i = 0; i < children.Length; i++)
                CompareNode(t.GetChild(i), children[i], def, diffs, ref nodesChecked, false);
        }
    }

    static void CmpV2(string path, string field, Vector2 actual, float[] wantArr, float[] fallback, List<object> diffs)
    {
        float[] want = (wantArr != null && wantArr.Length >= 2) ? wantArr : fallback;
        if (want == null)
        {
            diffs.Add(path + ": " + field + " build.json 缺值");
            return;
        }
        if (Mathf.Abs(actual.x - want[0]) > Eps || Mathf.Abs(actual.y - want[1]) > Eps)
            diffs.Add(path + ": " + field + " 期望 [" + want[0] + "," + want[1] + "] 实际 [" + actual.x + "," + actual.y + "]");
    }

    static string NodePath(Transform t)
    {
        var sb = new List<string>();
        while (t != null) { sb.Add(t.name); t = t.parent; }
        sb.Reverse();
        return string.Join("/", sb.ToArray());
    }
}
