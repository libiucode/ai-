' 创建指向 D 盘安装的桌面/开始菜单快捷方式。
' 纯 ASCII 脚本：中文文件名用 ChrW 按码点构造，避免代码页编码问题。
Set ws = CreateObject("WScript.Shell")
desktop = ws.SpecialFolders("Desktop")
startmenu = ws.SpecialFolders("Programs")

name = "AI" & ChrW(&H76D1) & ChrW(&H64AD) & ChrW(&H5DE5) & ChrW(&H5177) & ".lnk"
target = "D:\AI-Live-Monitor\AI" & ChrW(&H76D1) & ChrW(&H64AD) & ChrW(&H5DE5) & ChrW(&H5177) & ".exe"

Set l1 = ws.CreateShortcut(desktop & "\" & name)
l1.TargetPath = target
l1.WorkingDirectory = "D:\AI-Live-Monitor"
l1.Description = "AI live monitor"
l1.Save

Set l2 = ws.CreateShortcut(startmenu & "\" & name)
l2.TargetPath = target
l2.WorkingDirectory = "D:\AI-Live-Monitor"
l2.Description = "AI live monitor"
l2.Save

WScript.Echo "SHORTCUTS_OK " & desktop & "\" & name
