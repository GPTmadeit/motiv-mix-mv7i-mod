# MV7i Touch Panel Mod installer for Shure MOTIV Mix (Windows).
# This is the PowerShell half of MV7i-Mod-Installer.cmd; build.js embeds the mod files
# below and adds the batch launcher. Arguments: /update (from the in-app updater), /uninstall.
$ErrorActionPreference = 'Stop'
$ModVersion = '__MOD_VERSION__'
$RepoUrl = 'https://github.com/GPTmadeit/motiv-mix-mv7i-mod'
$Self = $env:MOD_SELF
$CmdArgs = "$env:MOD_ARGS"
$UpdateMode = $CmdArgs -match '(?i)/update'
$UninstallMode = $CmdArgs -match '(?i)/uninstall'
$StateDir = Join-Path $env:ProgramData 'MV7i-Mod'
$AcceptedFile = Join-Path $StateDir 'disclaimer-accepted.txt'

$PayloadPatcher = @'
__PAYLOAD_PATCHER__
'@
$PayloadMod = @'
__PAYLOAD_MOD__
'@

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

function Finish($code) {
  if (-not $UpdateMode -or $code -ne 0) {
    Write-Host ''
    Read-Host 'Press Enter to close' | Out-Null
  }
  exit $code
}

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# MOTIV Mix lives in Program Files, so relaunch elevated (one UAC prompt).
if (-not (Test-Admin)) {
  $cmd = "`$env:MOD_SELF = '" + $Self.Replace("'", "''") + "'; `$env:MOD_ARGS = '" + $CmdArgs.Replace("'", "''") +
    "'; iex ([IO.File]::ReadAllText(`$env:MOD_SELF))"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
  try {
    Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"
  } catch {
    Say 'Administrator permission is needed to modify MOTIV Mix. Nothing was changed.' Yellow
    Finish 1
  }
  exit 0
}

$Host.UI.RawUI.WindowTitle = "MV7i Touch Panel Mod v$ModVersion"
Clear-Host
Say "MV7i Touch Panel Mod for Shure MOTIV Mix  -  v$ModVersion" Cyan
Say $RepoUrl DarkGray
Say ''

function Show-Disclaimer {
  Say '======================================================================' Yellow
  Say ' IMPORTANT - PLEASE READ BEFORE INSTALLING' Yellow
  Say '======================================================================' Yellow
  Say ' * This is an UNOFFICIAL community mod. It is not affiliated with,'
  Say '   endorsed by, or supported by Shure Incorporated. Shure, MOTIV and'
  Say '   MV7i are trademarks of Shure Incorporated.'
  Say ' * This mod is FREE. It was made with NO INTENT OF MAKING MONEY from' White
  Say '   Shure''s work, and it must never be sold or bundled for profit.' White
  Say ' * It contains no Shure software. It changes the copy of MOTIV Mix'
  Say '   that is already installed on this PC, and keeps a backup of the'
  Say '   original so it can be removed at any time.'
  Say ' * Modifying MOTIV Mix may go against Shure''s software license.'
  Say '   You use this mod at your own risk. There is no warranty.'
  Say ' * To remove it, run this installer again and choose Uninstall,'
  Say '   or reinstall MOTIV Mix.'
  Say '======================================================================' Yellow
  Say ''
  $answer = Read-Host 'Type YES to accept and continue'
  if ($answer -ne 'YES') {
    Say 'Not accepted. Nothing was changed.' Yellow
    Finish 1
  }
  New-Item -ItemType Directory -Force $StateDir | Out-Null
  Set-Content $AcceptedFile "Accepted for v$ModVersion on $(Get-Date -Format s) by $env:USERNAME"
}

function Find-MotivMix {
  $candidates = New-Object System.Collections.Generic.List[string]
  $keys = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
          'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
          'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
  foreach ($entry in Get-ItemProperty $keys -ErrorAction SilentlyContinue) {
    if ("$($entry.DisplayName)" -notlike '*MOTIV Mix*') { continue }
    if ($entry.InstallLocation) { $candidates.Add($entry.InstallLocation.Trim('"')) }
    if ($entry.DisplayIcon) {
      $icon = ($entry.DisplayIcon -replace '"', '') -replace ',\s*-?\d+$', ''
      if ($icon) { $candidates.Add((Split-Path $icon -Parent)) }
    }
  }
  foreach ($proc in Get-Process -Name 'MOTIV Mix' -ErrorAction SilentlyContinue) {
    if ($proc.Path) { $candidates.Add((Split-Path $proc.Path -Parent)) }
  }
  $candidates.Add("$env:ProgramFiles\Shure\MOTIV Mix")
  $candidates.Add("$env:ProgramFiles\MOTIV Mix")
  $candidates.Add("$env:LOCALAPPDATA\Programs\MOTIV Mix")
  foreach ($dir in $candidates) {
    if ($dir -and (Test-Path (Join-Path $dir 'MOTIV Mix.exe')) -and (Test-Path (Join-Path $dir 'resources\app.asar'))) { return $dir }
  }
  $exe = Get-ChildItem $env:ProgramFiles -Filter 'MOTIV Mix.exe' -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($exe) { return $exe.DirectoryName }
  Say 'Could not find MOTIV Mix automatically.' Yellow
  $dir = (Read-Host 'Paste the folder that contains "MOTIV Mix.exe" (or press Enter to cancel)').Trim('"', ' ')
  if ($dir -and (Test-Path (Join-Path $dir 'MOTIV Mix.exe'))) { return $dir }
  return $null
}

function Close-MotivMix {
  $procs = Get-Process -Name 'MOTIV Mix' -ErrorAction SilentlyContinue
  if (-not $procs) { return }
  if ($UpdateMode) {
    Say 'Waiting for MOTIV Mix to close...'
    for ($i = 0; $i -lt 20 -and (Get-Process -Name 'MOTIV Mix' -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 1 }
  } else {
    Read-Host 'MOTIV Mix is running and will be closed. Press Enter to continue' | Out-Null
  }
  Get-Process -Name 'MOTIV Mix' -ErrorAction SilentlyContinue | Stop-Process -Force
  for ($i = 0; $i -lt 20 -and (Get-Process -Name 'MOTIV Mix' -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
}

# Runs src/patcher.js with MOTIV Mix's own Node runtime (Electron's RunAsNode).
function Invoke-Patcher($command) {
  $tmp = Join-Path $env:TEMP ('mv7i-mod-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory $tmp | Out-Null
  try {
    $patcher = Join-Path $tmp 'patcher.js'
    $mod = Join-Path $tmp 'tap-action.js'
    $result = Join-Path $tmp 'result.json'
    [IO.File]::WriteAllBytes($patcher, [Convert]::FromBase64String(($PayloadPatcher -replace '\s', '')))
    [IO.File]::WriteAllBytes($mod, [Convert]::FromBase64String(($PayloadMod -replace '\s', '')))
    $env:ELECTRON_RUN_AS_NODE = '1'
    $env:MOD_RESULT = $result
    $argList = @("`"$patcher`"", "`"$Resources`"", $command, "`"$mod`"")
    $proc = Start-Process -FilePath $Exe -ArgumentList $argList -Wait -PassThru -NoNewWindow `
      -RedirectStandardError (Join-Path $tmp 'stderr.txt') -RedirectStandardOutput (Join-Path $tmp 'stdout.txt')
    if (-not (Test-Path $result)) {
      $err = Get-Content (Join-Path $tmp 'stderr.txt') -Raw -ErrorAction SilentlyContinue
      return [pscustomobject]@{ ok = $false; error = "The patcher did not run (exit code $($proc.ExitCode)). $err" }
    }
    return Get-Content $result -Raw | ConvertFrom-Json
  } finally {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Remove-Item Env:MOD_RESULT -ErrorAction SilentlyContinue
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Start-MotivMix {
  # Started through Explorer so MOTIV Mix does not run as administrator.
  Start-Process explorer.exe -ArgumentList "`"$Exe`""
}

try {
  $Dir = Find-MotivMix
  if (-not $Dir) { Say 'MOTIV Mix was not found. Install it from shure.com first.' Red; Finish 1 }
  $Exe = Join-Path $Dir 'MOTIV Mix.exe'
  $Resources = Join-Path $Dir 'resources'
  Say "MOTIV Mix found in $Dir" DarkGray

  $status = Invoke-Patcher 'status'
  if (-not $status.ok) { Say "Could not read MOTIV Mix: $($status.error)" Red; Finish 1 }

  $action = 'install'
  if ($UninstallMode) {
    $action = 'uninstall'
  } elseif (-not $UpdateMode -and $status.installed) {
    Say ''
    Say "Mod v$($status.modVersion) is installed on MOTIV Mix $($status.appVersion). This installer is v$ModVersion."
    Say '  [1] Update / reinstall the mod'
    Say '  [2] Uninstall the mod (restore original MOTIV Mix)'
    Say '  [3] Exit'
    switch (Read-Host 'Choose 1, 2 or 3') {
      '1' { $action = 'install' }
      '2' { $action = 'uninstall' }
      default { Finish 0 }
    }
  }

  if ($action -eq 'install' -and -not ($UpdateMode -and (Test-Path $AcceptedFile))) {
    Show-Disclaimer
  }

  Close-MotivMix
  Say ''
  Say ($(if ($action -eq 'install') { 'Installing the mod...' } else { 'Removing the mod...' })) Cyan
  $result = Invoke-Patcher $action
  if (-not $result.ok) {
    Say "Failed: $($result.error)" Red
    Say 'MOTIV Mix was left as it was.' Yellow
    Finish 1
  }
  if ($action -eq 'install') {
    Say "Done! Mod v$($result.modVersion) installed on MOTIV Mix $($result.appVersion)." Green
    Say 'Open MOTIV Mix, select your MV7i, and find "Touch panel tap" at the bottom of its'
    Say 'page (also in the small tray window).'
  } else {
    Say 'Done! The original MOTIV Mix has been restored.' Green
  }
  if ($UpdateMode) {
    Start-MotivMix
  } elseif ((Read-Host 'Open MOTIV Mix now? (Y/n)') -notmatch '^(n|no)$') {
    Start-MotivMix
  }
  Finish 0
} catch {
  Say "Unexpected error: $_" Red
  Finish 1
}
