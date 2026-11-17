#requires -Version 5.1
<#
  screensaver-guard.ps1 —— 屏保守卫（守夜插件后端，t145 / t159 修）

  ===== 语义（按用户要求）=====
    开关 ON  -> 检查屏保：若开着就关掉
    开关 OFF -> 检查屏保：若当前与「原始值」不一致，恢复成原始值

  ===== t159 修复（独立复核 findings）=====
  F1 (blocker)：本文件曾以 UTF-8 **无 BOM** 保存，而计划任务用 powershell.exe 5.1 运行。
     5.1 把无 BOM 的 UTF-8 按系统代码页(GBK)解码，于是下面这些中文字面量路径变成乱码，
     Test-Path 恒失败，Get-GuardSwitch 恒 false —— 开关永远读不到（守卫对开关视而不见）。
     修法：①文件改写为 **UTF-8 with BOM**（5.1 按 UTF-8 读）；②开关文件读不到/读不懂时
     不再静默当 false，而是把原因写进输出的 warning，并把 screenGuard 报成 null 让调用方看见。
  F2/F3 (high)：「备份」曾记成「首次干预瞬间看到的值」，会把用户原值覆盖掉。
     修法：改为**原始基线**（screensaver-original.json），只在第一次见到它时写入一次，
     之后永不覆盖；ON 时即便屏保已经是关的，也要先把当时的真实值记成基线。
     恢复方向一律恢复到该基线，不硬编码 1。
#>
[CmdletBinding()]
param(
  [ValidateSet('status', 'disable', 'restore', 'apply')]
  [string]$Action = 'status',
  # 三个路径留空时按 DSH_HOME / ~/.dsh 推导（插件调用时总会显式传参）
  [string]$FlagFile = '',
  [string]$OriginalFile = '',
  [string]$PowerFile = ''
)

$ErrorActionPreference = 'Stop'
$deskKey = 'HKCU:\Control Panel\Desktop'

$dataDir = if ($env:DSH_HOME) { Join-Path $env:DSH_HOME 'nightwatch' } else { Join-Path $env:USERPROFILE '.dsh\nightwatch' }
if (-not $FlagFile) { $FlagFile = Join-Path $dataDir 'guard-toggle.json' }
if (-not $OriginalFile) { $OriginalFile = Join-Path $dataDir 'screensaver-original.json' }
if (-not $PowerFile) { $PowerFile = Join-Path $dataDir 'power-original.json' }

function Read-State {
  $props = Get-ItemProperty -Path $deskKey -ErrorAction SilentlyContinue
  return [ordered]@{
    active  = if ($null -ne $props.ScreenSaveActive) { [int]$props.ScreenSaveActive } else { $null }
    timeout = if ($null -ne $props.ScreenSaveTimeOut) { [string]$props.ScreenSaveTimeOut } else { $null }
    exe     = if ($null -ne $props.'SCRNSAVE.EXE') { [string]$props.'SCRNSAVE.EXE' } else { $null }
  }
}

function Apply-Active([int]$value) {
  Set-ItemProperty -Path $deskKey -Name 'ScreenSaveActive' -Value ([string]$value) -Type String
  try {
    if (-not ('Win32Spi' -as [type])) {
      Add-Type -Namespace '' -Name 'Win32Spi' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, System.IntPtr pvParam, uint fWinIni);
'@
    }
    [void][Win32Spi]::SystemParametersInfo(0x0011, [uint32]$value, [IntPtr]::Zero, 3)
    return $true
  } catch {
    return $false
  }
}

# 原始基线：只写一次，永不覆盖（F2/F3 的修法）
function Ensure-Original {
  if (Test-Path -LiteralPath $OriginalFile) { return $false }
  $cur = Read-State
  # t162 边界：基线文件被删掉、而守卫正开着把 active 强制成 0 时，这次重建会把 0 当成
  # 「用户原值」——那不是用户的值，是守卫自己造成的。所以这里标 suspect，让调用方看见。
  $suspect = $false
  $why = $null
  if ($cur.active -eq 0) {
    try {
      if (Test-Path -LiteralPath $FlagFile) {
        $rawFlag = Get-Content -LiteralPath $FlagFile -Raw
        if ($rawFlag -match '"screenGuard"\s*:\s*true') {
          $suspect = $true
          $why = 'baseline captured while screenGuard=true and active=0; the 0 may be caused by the guard itself, not by the user'
        }
      }
    } catch { }
  }
  $dir = Split-Path -Parent $OriginalFile
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $rec = [ordered]@{
    at      = (Get-Date).ToString('o')
    active  = $cur.active
    timeout = $cur.timeout
    exe     = $cur.exe
    note    = 'original baseline captured once; never overwritten'
  }
  if ($suspect) { $rec.suspect = $true; $rec.suspectReason = $why }
  ($rec | ConvertTo-Json -Compress) | Set-Content -LiteralPath $OriginalFile -Encoding UTF8
  return $true
}

function Read-Original {
  if (-not (Test-Path -LiteralPath $OriginalFile)) { return $null }
  try {
    return (Get-Content -LiteralPath $OriginalFile -Raw | ConvertFrom-Json)
  } catch { return $null }
}

# ===== t176：电源计划（关屏 / 睡眠）也一起守 =====
# 用户实测：屏幕保护关了，但电池模式下「5 分钟关屏、2 小时睡眠」照样会把引擎停掉。
# 所以屏保守卫同时管四个超时（VIDEOIDLE / STANDBYIDLE × AC/DC）：
#   开 -> 全部设为 0（从不）；关 -> 恢复原始基线（只记一次，永不覆盖）。

# 解析 powercfg /query 输出：取所有 0x 值，最后两个分别是 AC、DC。
# （输出跟着系统语言走，所以不匹配标签，只取数值——最小/最大/增量在前，当前 AC/DC 在最后两行。）
function Get-PowerTimeouts {
  $video = (powercfg /query SCHEME_CURRENT SUB_VIDEO VIDEOIDLE 2>$null) -join "`n"
  $sleep = (powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>$null) -join "`n"
  $pairs = {
    param([string]$text)
    $vals = @()
    foreach ($m in [regex]::Matches($text, '0x([0-9a-fA-F]+)')) {
      $vals += [int64]([Convert]::ToUInt32($m.Groups[1].Value, 16))
    }
    if ($vals.Count -lt 2) { return @{ ac = $null; dc = $null } }
    return @{ ac = $vals[$vals.Count - 2]; dc = $vals[$vals.Count - 1] }
  }
  $v = & $pairs $video
  $s = & $pairs $sleep
  return [ordered]@{
    videoAc = $v.ac
    videoDc = $v.dc
    sleepAc = $s.ac
    sleepDc = $s.dc
  }
}

function Read-PowerOriginal {
  if (-not (Test-Path -LiteralPath $PowerFile)) { return $null }
  try {
    return (Get-Content -LiteralPath $PowerFile -Raw | ConvertFrom-Json)
  } catch { return $null }
}

# 基线只写一次；若四个值全是 0 且当前屏幕守卫是开的，注明 suspect（0 可能是守卫自己造成的）
function Ensure-PowerOriginal {
  if (Test-Path -LiteralPath $PowerFile) { return $false }
  $cur = Get-PowerTimeouts
  $suspect = $false
  $why = $null
  if ($cur.videoAc -eq 0 -and $cur.videoDc -eq 0 -and $cur.sleepAc -eq 0 -and $cur.sleepDc -eq 0) {
    try {
      if (Test-Path -LiteralPath $FlagFile) {
        $rawFlag = Get-Content -LiteralPath $FlagFile -Raw
        if ($rawFlag -match '"screenGuard"\s*:\s*true') {
          $suspect = $true
          $why = 'power baseline captured while screenGuard=true and all timeouts are 0; zeros may be caused by the guard'
        }
      }
    } catch { }
  }
  $dir = Split-Path -Parent $PowerFile
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $rec = [ordered]@{
    at      = (Get-Date).ToString('o')
    videoAc = $cur.videoAc
    videoDc = $cur.videoDc
    sleepAc = $cur.sleepAc
    sleepDc = $cur.sleepDc
    note    = 'power baseline captured once; never overwritten'
  }
  if ($suspect) { $rec.suspect = $true; $rec.suspectReason = $why }
  ($rec | ConvertTo-Json -Compress) | Set-Content -LiteralPath $PowerFile -Encoding UTF8
  return $true
}

# 写四个超时并应用。值单位是秒；0 = 从不。
function Set-PowerTimeouts([int64]$videoAc, [int64]$videoDc, [int64]$sleepAc, [int64]$sleepDc) {
  $ok = $true
  $jobs = @(
    @('/setacvalueindex', 'SUB_VIDEO', 'VIDEOIDLE', $videoAc),
    @('/setdcvalueindex', 'SUB_VIDEO', 'VIDEOIDLE', $videoDc),
    @('/setacvalueindex', 'SUB_SLEEP', 'STANDBYIDLE', $sleepAc),
    @('/setdcvalueindex', 'SUB_SLEEP', 'STANDBYIDLE', $sleepDc)
  )
  foreach ($j in $jobs) {
    & powercfg $j[0] SCHEME_CURRENT $j[1] $j[2] ([string]$j[3]) 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { $ok = $false }
  }
  & powercfg /setactive SCHEME_CURRENT 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { $ok = $false }
  return $ok
}

# 开关：不再静默吞错（F1 第二半）
function Get-GuardSwitch {
  if (-not (Test-Path -LiteralPath $FlagFile)) {
    return [ordered]@{ value = $null; warning = ('flag file not found: ' + $FlagFile) }
  }
  try {
    $raw = Get-Content -LiteralPath $FlagFile -Raw
  } catch {
    return [ordered]@{ value = $null; warning = ('flag file unreadable: ' + $_.Exception.Message) }
  }
  if ($raw -notmatch '"screenGuard"') {
    return [ordered]@{ value = $null; warning = 'flag file has no screenGuard field' }
  }
  if ($raw -match '"screenGuard"\s*:\s*true') { return [ordered]@{ value = $true; warning = $null } }
  if ($raw -match '"screenGuard"\s*:\s*false') { return [ordered]@{ value = $false; warning = $null } }
  return [ordered]@{ value = $null; warning = 'screenGuard value is not a boolean' }
}

$result = [ordered]@{ at = (Get-Date).ToString('o'); action = $Action; script = 'screensaver-guard.ps1'; rev = 't176-power' }
$created = Ensure-Original
$result.originalCreatedNow = $created
$result.original = Read-Original
$powerCreated = Ensure-PowerOriginal
$result.powerOriginalCreatedNow = $powerCreated
$result.powerOriginal = Read-PowerOriginal
$sw = Get-GuardSwitch
$result.screenGuard = $sw.value
if ($sw.warning) { $result.warning = $sw.warning }

switch ($Action) {
  'status' {
    $result.state = Read-State
    $result.power = Get-PowerTimeouts
  }
  'disable' {
    $result.spiApplied = Apply-Active 0
    $result.state = Read-State
    # t176：关屏/睡眠也一起设「从不」，否则电池模式下引擎照样会被睡眠停掉
    $result.powerApplied = Set-PowerTimeouts 0 0 0 0
    $result.power = Get-PowerTimeouts
    $result.note = if ($result.powerApplied) { 'screensaver off; display+sleep set to never (AC+DC)' } else { 'screensaver off; powercfg change failed' }
  }
  'restore' {
    $orig = Read-Original
    if ($null -eq $orig -or $null -eq $orig.active) {
      $result.note = 'no original baseline recorded; nothing to restore'
    } else {
      $want = [int]$orig.active
      $cur = (Read-State).active
      if ($cur -eq $want) {
        $result.note = ('already at original active=' + $want)
      } else {
        $result.spiApplied = Apply-Active $want
        if ($orig.timeout) { try { Set-ItemProperty -Path $deskKey -Name 'ScreenSaveTimeOut' -Value ([string]$orig.timeout) -Type String } catch { } }
        if ($orig.exe) { try { Set-ItemProperty -Path $deskKey -Name 'SCRNSAVE.EXE' -Value ([string]$orig.exe) -Type String } catch { } }
        $result.note = ('restored to original active=' + $want)
      }
      $result.state = Read-State
    }
    # t176：电源超时恢复到基线
    $pOrig = Read-PowerOriginal
    if ($null -eq $pOrig) {
      $result.note = (@($result.note, 'power untouched (no baseline)') | Where-Object { $_ }) -join '; '
    } else {
      $result.powerApplied = Set-PowerTimeouts ([int64]$pOrig.videoAc) ([int64]$pOrig.videoDc) ([int64]$pOrig.sleepAc) ([int64]$pOrig.sleepDc)
      $result.power = Get-PowerTimeouts
      $add = if ($result.powerApplied) { 'power restored' } else { 'power restore failed' }
      $result.note = (@($result.note, $add) | Where-Object { $_ }) -join '; '
    }
  }
  'apply' {
    if ($sw.value -eq $true) {
      if ((Read-State).active -eq 0) {
        $result.note = 'screenGuard=on; screensaver already off'
      } else {
        $result.spiApplied = Apply-Active 0
        $result.note = 'screenGuard=on; disabled'
      }
      $result.powerApplied = Set-PowerTimeouts 0 0 0 0
      $result.power = Get-PowerTimeouts
    } elseif ($sw.value -eq $false) {
      $orig = Read-Original
      if ($null -eq $orig -or $null -eq $orig.active) {
        $result.note = 'screenGuard=off; no original baseline; nothing to restore'
      } else {
        $want = [int]$orig.active
        $cur = (Read-State).active
        if ($cur -eq $want) {
          $result.note = ('screenGuard=off; already at original active=' + $want)
        } else {
          $result.spiApplied = Apply-Active $want
          $result.note = ('screenGuard=off; restored to original active=' + $want)
        }
      }
      $pOrig = Read-PowerOriginal
      if ($null -ne $pOrig) {
        $result.powerApplied = Set-PowerTimeouts ([int64]$pOrig.videoAc) ([int64]$pOrig.videoDc) ([int64]$pOrig.sleepAc) ([int64]$pOrig.sleepDc)
        $result.power = Get-PowerTimeouts
      }
    } else {
      # 开关读不到：不动任何东西，如实上报（F1）
      $result.note = 'screenGuard unreadable; no action taken'
    }
    $result.state = Read-State
  }
}

($result | ConvertTo-Json -Depth 5 -Compress)
