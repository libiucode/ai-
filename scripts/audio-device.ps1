# 通过 IPolicyConfig COM 接口切换 Windows 默认音频设备（播放/录音）。
# 本机没有 AudioDeviceCmdlets / nircmd，注册表 Sound Mapper 键也不存在，
# 因此用未公开的 IPolicyConfig 接口（与 SoundVolumeView 等工具同源）。
#
# 用法：
#   & ([scriptblock]::Create([System.IO.File]::ReadAllText("$PWD\scripts\audio-device.ps1", [System.Text.Encoding]::UTF8)))
#   Get-DefaultAudioDevice -Kind playback
#   Set-DefaultAudioDevice -DeviceId "{0.0.0.00000000}.{...}" -Kind playback

$script:IpcCode = @'
using System;
using System.Runtime.InteropServices;

[Guid("F8679F50-1E15-4A0F-9B36-7B9B1D1B1B1B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPolicyConfigVista {
  int GetMixFormat(string pszDeviceName, IntPtr ppFormat);
  int GetDeviceFormat(string pszDeviceName, bool bDefault, IntPtr ppFormat);
  int ResetDeviceFormat(string pszDeviceName);
  int SetDeviceFormat(string pszDeviceName, IntPtr pEndpointFormat, IntPtr mixFormat);
  int GetProcessingPeriod(string pszDeviceName, bool bDefault, IntPtr pmftDefaultPeriod, IntPtr pmftMinimumPeriod);
  int SetProcessingPeriod(string pszDeviceName, IntPtr pmftPeriod);
  int GetShareMode(string pszDeviceName, IntPtr pMode);
  int SetShareMode(string pszDeviceName, IntPtr mode);
  int GetPropertyValue(string pszDeviceName, bool bFxStore, IntPtr key, IntPtr pv);
  int SetPropertyValue(string pszDeviceName, bool bFxStore, IntPtr key, IntPtr pv);
  int SetDefaultEndpoint(string pszDeviceName, int role);
  int SetEndpointVisibility(string pszDeviceName, bool bVisible);
}

// Win7+ 的 PolicyConfig COM 对象用 IID F8679F50-... 做 QueryInterface 会 E_NOINTERFACE。
// 因此不在这里做强制转换，改为在 PowerShell 侧用 late-binding（InvokeMember）调用。
public class AudioDeviceSwitcher {
  public static object CreatePolicyConfig() {
    var t = Type.GetTypeFromCLSID(new Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9"));
    return Activator.CreateInstance(t);
  }
}
'@

if (-not ("AudioDeviceSwitcher" -as [type])) { Add-Type -TypeDefinition $script:IpcCode }

# 枚举音频端点（MMDevice API）
$script:EnumCode = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
  int GetDevice(string id, out IMMDevice device);
  int RegisterEndpointNotificationCallback(IntPtr client);
  int UnregisterEndpointNotificationCallback(IntPtr client);
}
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection {
  int GetCount(out int count);
  int Item(int index, out IMMDevice device);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  int OpenPropertyStore(int access, out IPropertyStore store);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  int GetState(out int state);
}
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
  int GetCount(out int count);
  int GetAt(int index, out PROPERTYKEY key);
  int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
  int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
  int Commit();
}
[StructLayout(LayoutKind.Sequential)]
public struct PROPERTYKEY { public Guid fmtid; public int pid; }
[StructLayout(LayoutKind.Explicit, Size = 24)]
public struct PROPVARIANT {
  [FieldOffset(0)] public short vt;
  [FieldOffset(2)] public short wReserved1;
  [FieldOffset(4)] public short wReserved2;
  [FieldOffset(6)] public short wReserved3;
  [FieldOffset(8)] public IntPtr pointerValue;
  [FieldOffset(8)] public int intValue;
}
public class AudioEndpoints {
  public class Info { public string Id; public string Name; public bool IsDefault; }
  // dataFlow: 0=render(playback), 1=capture(recording)
  public static List<Info> List(int dataFlow) {
    var list = new List<Info>();
    var t = Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"));
    var en = (IMMDeviceEnumerator)Activator.CreateInstance(t);
    string defId = null;
    IMMDevice def;
    if (en.GetDefaultAudioEndpoint(dataFlow, 0, out def) == 0 && def != null) { def.GetId(out defId); }
    IMMDeviceCollection col; en.EnumAudioEndpoints(dataFlow, 1, out col);
    int n; col.GetCount(out n);
    var pk = new PROPERTYKEY();
    pk.fmtid = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"); pk.pid = 14; // PKEY_Device_FriendlyName
    for (int i = 0; i < n; i++) {
      IMMDevice d; col.Item(i, out d);
      string id; d.GetId(out id);
      string name = "(unknown)";
      try {
        IPropertyStore ps; d.OpenPropertyStore(0, out ps);
        PROPVARIANT pv; ps.GetValue(ref pk, out pv);
        if (pv.vt == 31 && pv.pointerValue != IntPtr.Zero) {
          name = Marshal.PtrToStringUni(pv.pointerValue);
        }
        Marshal.ReleaseComObject(ps);
      } catch { }
      list.Add(new Info { Id = id, Name = name, IsDefault = (id == defId) });
      Marshal.ReleaseComObject(d);
    }
    return list;
  }
}
'@
if (-not ("AudioEndpoints" -as [type])) { Add-Type -TypeDefinition $script:EnumCode }

function Get-AudioDevices {
  param([ValidateSet("playback", "recording")][string]$Kind = "playback")
  $flow = if ($Kind -eq "playback") { 0 } else { 1 }
  return [AudioEndpoints]::List($flow)
}

function Set-DefaultAudioDevice {
  param([Parameter(Mandatory=$true)][string]$DeviceId, [ValidateSet("playback","recording")][string]$Kind = "playback")
  if ($Kind -ne "playback") { throw "本脚本只实现了 playback 切换" }
  $o = [AudioDeviceSwitcher]::CreatePolicyConfig()
  # late-binding 调用 SetDefaultEndpoint(deviceId, role)；role 0/1/2 = Console/Multimedia/Communications
  $codes = @()
  foreach ($role in 0, 1, 2) {
    try {
      $r = $o.GetType().InvokeMember(
        "SetDefaultEndpoint",
        [System.Reflection.BindingFlags]::InvokeMethod,
        $null, $o, @($DeviceId, $role)
      )
      $codes += [int]$r
    } catch {
      $codes += -1
    }
  }
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($o) | Out-Null
  return $codes
}
