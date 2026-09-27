# 灵台 · 桌面快捷方式生成器
# 用途:重建桌面「灵台」快捷方式,指向源码树里的 electron(双击秒开、永远跑最新代码)。
# 改名/搬家后重跑一遍即可,无需手工改 lnk。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$project  = Split-Path -Parent $PSScriptRoot   # 本脚本位于 <项目>\build\，项目根取上一级
$electron = Join-Path $project 'node_modules\electron\dist\electron.exe'
$icon     = Join-Path $project 'build\icon.ico'

# 依赖先验:目标与图标缺了就 fail fast,不生成残废快捷方式
foreach ($f in @($electron, $icon)) {
  if (-not (Test-Path $f)) { throw "缺少依赖文件: $f" }
}

$lnkPath = Join-Path $env:USERPROFILE 'Desktop\灵台.lnk'
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnkPath)
$s.TargetPath       = $electron
$s.Arguments        = '.'
$s.WorkingDirectory = $project
$s.IconLocation     = "$icon,0"
$s.Description      = '灵台 · 本地模型总控(观测 + 启动器 + 实验台 + 总控大屏)'
$s.WindowStyle      = 1   # 正常窗口,不最小化不最大化
$s.Save()

# 回读校验:写完必须验证,避免静默坏链
$v = $shell.CreateShortcut($lnkPath)
"已生成: $lnkPath"
"Target : $($v.TargetPath)"
"Args   : $($v.Arguments)"
"WorkDir: $($v.WorkingDirectory)"
"Icon   : $($v.IconLocation)"
if ($v.TargetPath -ne $electron -or $v.Arguments -ne '.') { throw '回读校验失败' }
