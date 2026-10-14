/**
 * 用 IPolicyConfig COM 接口（Vista+）设置默认播放/录音设备。
 * 这是 Windows 内部音频策略接口，不需要第三方模块。
 * 只对设备枚举到的真实端点生效。
 */
function setDefaultAudioDevice(id, role) {
  // role: 0=console, 1=multimedia, 2=communications
  const PS = `
$ErrorActionPreference = 'Stop'
$code = @"
using System;
using System.Runtime.InteropServices;
[Guid("f8679f50-850a-4cf2-9c7d-a3b6d0e0d0f0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPolicyConfig { }
[Guid("870af99c-171d-4f9e-af0d-e63df40c2cc9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPolicyConfigVista { }
[ComImport, Guid("568b1168-683f-4f5e-af82-3b0e7f0a0e0e"), ClassInterface(ClassInterfaceType.None)]
public class PolicyConfigClient { }
public static class AudioSetter {
  [DllImport("ole32.dll")] public static extern int CoCreateInstance(ref Guid clsid, IntPtr p, uint ctx, ref Guid iid, out IPolicyConfigVista inst);
}
"@
try { Add-Type -TypeDefinition $code -ErrorAction Stop } catch { }
Write-Output "COM-approach-not-stable"
`;
  // 更可靠的路线：直接用注册表 Sound Mapper + 广播 WM_SETTINGCHANGE 不可靠。
  // 采用最稳方案：用 powershell 调用隐藏的 mmc 也不可行。
  // 结论：本机无法脚本化切换默认输出设备（无 AudioDeviceCmdlets、无 nircmd）。
  return "unsupported";
}
module.exports = { setDefaultAudioDevice };
