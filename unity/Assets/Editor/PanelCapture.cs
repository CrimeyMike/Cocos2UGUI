// PanelCapture.cs — P5 预埋：batchmode 下为 Assets/Panels 中的 prefab 搭建 Canvas 场景，
// 用正交相机渲染到 750x1334 RenderTexture 并导出 PNG（不追求像素完美，能出图即可）。
//
// batchmode 入口:
//   Unity.exe -batchmode -quit -projectPath <proj> -executeMethod PanelCapture.CaptureAll
// 可选参数:
//   -panel <name>    仅截指定面板（默认全部）
//   -outDir <dir>    输出目录（默认 <工程根>/../captures，即 cocos2ugui/unity/captures）
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

public static class PanelCapture
{
    [MenuItem("Tools/Cocos2Ugui/3. Capture Panels")]
    public static void CaptureAll()
    {
        string panelFilter = C2UShared.GetArg("panel");
        string outDir = C2UShared.GetArg("outDir");
        if (string.IsNullOrEmpty(outDir)) outDir = Path.Combine(C2UShared.ProjectRoot, "..", "captures");
        outDir = Path.GetFullPath(outDir);
        Directory.CreateDirectory(outDir);

        // 从 build.json 取各面板设计分辨率（缺省 750x1334）
        var resByPanel = new Dictionary<string, Vector2>(StringComparer.OrdinalIgnoreCase);
        var warnings = new List<string>();
        foreach (var f in C2UShared.FindBuildFiles(warnings))
        {
            try
            {
                var d = C2UShared.LoadBuild(f);
                resByPanel[d.meta.panel] = new Vector2(d.meta.designResolution.width, d.meta.designResolution.height);
            }
            catch { }
        }

        var prefabPaths = AssetDatabase.FindAssets("t:Prefab", new[] { "Assets/Panels" })
            .Select(AssetDatabase.GUIDToAssetPath)
            .Where(p => !string.IsNullOrEmpty(p))
            .OrderBy(p => p, StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (prefabPaths.Count == 0)
        {
            Debug.LogWarning("[C2UCapture] Assets/Panels 下没有 prefab，先运行 Cocos2UguiBuilder.BuildAll");
            return;
        }

        int done = 0, failed = 0;
        var results = new List<object>();
        foreach (var pp in prefabPaths)
        {
            string panel = Path.GetFileNameWithoutExtension(pp);
            if (!string.IsNullOrEmpty(panelFilter) && !string.Equals(panelFilter, panel, StringComparison.OrdinalIgnoreCase))
                continue;
            Vector2 res;
            if (!resByPanel.TryGetValue(panel, out res)) res = new Vector2(750f, 1334f);
            try
            {
                string png = CaptureOne(pp, panel, res, outDir);
                results.Add(new Dictionary<string, object> { { "panel", panel }, { "ok", true }, { "png", png } });
                done++;
            }
            catch (Exception e)
            {
                Debug.LogError("[C2UCapture] 截图失败 " + panel + ": " + e);
                results.Add(new Dictionary<string, object> { { "panel", panel }, { "ok", false }, { "error", e.Message } });
                failed++;
            }
        }

        string reportPath = Path.Combine(C2UShared.ProjectRoot, "Reports", "capture-report.json");
        C2UShared.WriteTextFile(reportPath, C2UShared.ToJson(new Dictionary<string, object>
        {
            { "tool", "PanelCapture" }, { "generatedAt", DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") },
            { "outDir", outDir }, { "captured", done }, { "failed", failed }, { "panels", results },
        }));
        Debug.Log("[C2UCapture] 完成 " + done + "/" + (done + failed) + " -> " + outDir + "（报告 " + reportPath + "）");
        if (failed > 0 && C2UShared.InBatchMode)
            EditorApplication.Exit(3);
    }

    static string CaptureOne(string prefabPath, string panel, Vector2 res, string outDir)
    {
        EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
        if (prefab == null) throw new Exception("prefab 加载失败: " + prefabPath);

        // WorldSpace Canvas（尺寸=设计分辨率，居中原点）
        var canvasGo = new GameObject("CaptureCanvas", typeof(Canvas));
        canvasGo.layer = 5; // UI
        var canvas = canvasGo.GetComponent<Canvas>();
        canvas.renderMode = RenderMode.WorldSpace;
        var crt = (RectTransform)canvasGo.transform;
        crt.SetParent(null, false);
        crt.position = Vector3.zero;
        crt.localScale = Vector3.one;
        crt.sizeDelta = res;
        crt.pivot = new Vector2(0.5f, 0.5f);

        var instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
        if (instance == null) throw new Exception("prefab 实例化失败: " + prefabPath);
        instance.transform.SetParent(crt, false);

        // 正交相机正对 Canvas
        var camGo = new GameObject("CaptureCamera", typeof(Camera));
        camGo.layer = 5;
        var cam = camGo.GetComponent<Camera>();
        cam.orthographic = true;
        cam.orthographicSize = res.y * 0.5f;
        cam.clearFlags = CameraClearFlags.SolidColor;
        cam.backgroundColor = new Color(0.13f, 0.13f, 0.13f, 1f);
        cam.cullingMask = (1 << 5); // UI
        cam.nearClipPlane = 0.1f;
        cam.farClipPlane = 3000f;
        cam.transform.position = new Vector3(0f, 0f, -1000f);
        cam.transform.rotation = Quaternion.identity;
        cam.gameObject.SetActive(true);

        int w = Mathf.RoundToInt(res.x), h = Mathf.RoundToInt(res.y);
        var rt = new RenderTexture(w, h, 24, RenderTextureFormat.ARGB32);
        cam.targetTexture = rt;
        cam.Render();
        RenderTexture.active = rt;
        var tex = new Texture2D(w, h, TextureFormat.RGBA32, false);
        tex.ReadPixels(new Rect(0, 0, w, h), 0, 0);
        tex.Apply();
        RenderTexture.active = null;
        cam.targetTexture = null;

        string pngPath = Path.Combine(outDir, panel + ".png");
        File.WriteAllBytes(pngPath, tex.EncodeToPNG());

        UnityEngine.Object.DestroyImmediate(tex);
        rt.Release();
        UnityEngine.Object.DestroyImmediate(rt);
        UnityEngine.Object.DestroyImmediate(camGo);
        UnityEngine.Object.DestroyImmediate(canvasGo);
        Debug.Log("[C2UCapture] " + panel + " -> " + pngPath + " (" + w + "x" + h + ")");
        return pngPath;
    }
}
