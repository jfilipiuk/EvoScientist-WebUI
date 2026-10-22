# Measurement 3: does a UI server survive when the Electron main process is
# ended with TerminateProcess ("Kill Process", not "Kill Process Tree")?
#   -Variant suspended   suspend the UI server first (the issue's case)
#   -Variant running     control: the UI server keeps running
# Writes <MEASURE_OUT>\orphan.<variant>.json and prints it.
param(
    [Parameter(Mandatory = $true)][ValidateSet('suspended', 'running')][string]$Variant,
    [Parameter(Mandatory = $true)][string]$Electron
)
$ErrorActionPreference = 'Stop'
$out = $env:MEASURE_OUT
New-Item -ItemType Directory -Force -Path $out | Out-Null
$pidsFile = Join-Path $out 'orphan.pids.json'
Remove-Item -LiteralPath $pidsFile -ErrorAction SilentlyContinue

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Orphan {
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr process);
    public static string InJob(uint pid) {
        IntPtr h = OpenProcess(0x1000 /* QUERY_LIMITED_INFORMATION */, false, pid);
        if (h == IntPtr.Zero) return "open failed " + Marshal.GetLastWin32Error();
        bool r; bool ok = IsProcessInJob(h, IntPtr.Zero, out r);
        CloseHandle(h);
        return ok ? r.ToString().ToLower() : "query failed " + Marshal.GetLastWin32Error();
    }
    public static int Suspend(uint pid) {
        IntPtr h = OpenProcess(0x0800 /* SUSPEND_RESUME */, false, pid);
        if (h == IntPtr.Zero) return -1;
        int status = NtSuspendProcess(h);
        CloseHandle(h);
        return status;
    }
}
"@

$appDir = $PSScriptRoot
$proc = Start-Process -FilePath $Electron -ArgumentList "`"$appDir`"", '--mode=orphan' -PassThru
$deadline = (Get-Date).AddSeconds(60)
while (-not (Test-Path -LiteralPath $pidsFile)) {
    if ((Get-Date) -gt $deadline) { throw "No pid file from the probe app within 60 s" }
    Start-Sleep -Milliseconds 200
}
$pids = Get-Content -Raw $pidsFile | ConvertFrom-Json
$ui = Get-Process -Id $pids.ui
$uiStart = $ui.StartTime

$record = [ordered]@{
    measurement = 3
    variant = $Variant
    main_pid = $pids.main
    ui_pid = $pids.ui
    started_main_pid = $proc.Id
    ui_in_job_before = [Orphan]::InJob([uint32]$pids.ui)
    main_in_job_before = [Orphan]::InJob([uint32]$pids.main)
}
if ($Variant -eq 'suspended') {
    $record.suspend_status = [Orphan]::Suspend([uint32]$pids.ui)
}
# TerminateProcess on the main process only.
Stop-Process -Id $pids.main -Force
$record.killed_at = (Get-Date).ToString('o')
$gone = $false
for ($i = 0; $i -lt 50; $i++) {
    Start-Sleep -Milliseconds 100
    $p = Get-Process -Id $pids.ui -ErrorAction SilentlyContinue
    if (-not $p -or $p.StartTime -ne $uiStart) { $gone = $true; break }
}
$record.ui_gone_within_5s = $gone
$record.ui_gone_after_ms = if ($gone) { ($i + 1) * 100 } else { $null }
if (-not $gone) {
    Stop-Process -Id $pids.ui -Force -ErrorAction SilentlyContinue
    $record.cleanup = 'ui stand-in ended by the check'
}
$json = $record | ConvertTo-Json
$json | Out-File -FilePath (Join-Path $out "orphan.$Variant.json") -Encoding utf8
$json
