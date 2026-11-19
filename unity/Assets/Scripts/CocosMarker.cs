// CocosMarker.cs — P4 内建标记组件：build.json 中无法映射到 UGUI 的组件（sp.Skeleton、
// cc.Graphics 等，契约 components[].type == "Marker"）统一挂此空 MonoBehaviour。
// reason = 无法映射的原因；source = 来源组件。由 Cocos2UguiBuilder 自动挂载并写入字段，
// 人工检查后可整体移除。另被用作 CustomScript stub 首次生成、尚未编译时的占位
// （reason 前缀 __C2U_CUSTOMSCRIPT__，保存后由生成器把 m_Script guid 替换为 stub 的 guid）。
using UnityEngine;

public class CocosMarker : MonoBehaviour
{
    [Tooltip("无法映射到 UGUI 的原因")] public string reason;
    [Tooltip("来源 Cocos 组件")] public string source;
}
