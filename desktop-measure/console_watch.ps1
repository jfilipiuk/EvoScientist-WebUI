# Measurement 1 watcher. Started by main.cjs (mode consoles) as its own child,
# with pipes and windowsHide, so it has no console window of its own.
# Until -StopFile exists, every 150 ms it:
#   - lists every descendant of -RootPid (except itself) and, for each one it
#     has not checked in the last second, attaches to its console:
#     AttachConsole(pid) -> GetConsoleWindow() -> IsWindowVisible() -> FreeConsole();
#   - lists visible top-level console windows (classic console, Windows
#     Terminal, pseudo console) that were not there at the start.
# Each new observation is one JSON line in -Out.
param(
    [Parameter(Mandatory = $true)][int]$RootPid,
    [Parameter(Mandatory = $true)][string]$Out,
    [Parameter(Mandatory = $true)][string]$StopFile
)
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class ConsoleWatch {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32 {
        public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
        public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll")] public static extern bool FreeConsole();
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

    public class Proc { public uint Pid; public uint Ppid; public string Exe; }

    public static List<Proc> Snapshot() {
        var list = new List<Proc>();
        IntPtr snap = CreateToolhelp32Snapshot(2 /* TH32CS_SNAPPROCESS */, 0);
        var e = new PROCESSENTRY32(); e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
        if (Process32FirstW(snap, ref e)) {
            do { list.Add(new Proc { Pid = e.th32ProcessID, Ppid = e.th32ParentProcessID, Exe = e.szExeFile }); }
            while (Process32NextW(snap, ref e));
        }
        CloseHandle(snap);
        return list;
    }

    // "none:<err>" when the process has no console (6) or is gone/denied,
    // else "hwnd=<h> visible=<bool>".
    public static string Probe(uint pid) {
        FreeConsole();
        if (!AttachConsole(pid)) return "none:" + Marshal.GetLastWin32Error();
        IntPtr h = GetConsoleWindow();
        bool visible = h != IntPtr.Zero && IsWindowVisible(h);
        FreeConsole();
        return "hwnd=0x" + h.ToInt64().ToString("X") + " visible=" + visible.ToString().ToLower();
    }

    static readonly string[] ConsoleClasses = { "ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS", "PseudoConsoleWindow" };

    public static List<string> VisibleConsoleWindows() {
        var found = new List<string>();
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h)) return true;
            var c = new StringBuilder(256); GetClassName(h, c, 256);
            if (Array.IndexOf(ConsoleClasses, c.ToString()) < 0) return true;
            uint pid; GetWindowThreadProcessId(h, out pid);
            found.Add("0x" + h.ToInt64().ToString("X") + "|" + c + "|" + pid);
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@

$self = [uint32]$PID
$t0 = Get-Date
function Emit($obj) {
    $obj['t_ms'] = [int]((Get-Date) - $t0).TotalMilliseconds
    ($obj | ConvertTo-Json -Compress) | Out-File -FilePath $Out -Append -Encoding utf8
}

$baseline = @{}
foreach ($w in [ConsoleWatch]::VisibleConsoleWindows()) { $baseline[$w] = $true }
Emit @{ kind = 'start'; root = $RootPid; self = $self; baseline_visible_console_windows = @($baseline.Keys) }
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()

$lastProbe = @{}   # pid -> time of last probe
$lastState = @{}   # pid -> last probe result
$names = @{}       # pid -> exe
$seenWindows = @{}
while (-not (Test-Path -LiteralPath $StopFile)) {
    $procs = [ConsoleWatch]::Snapshot()
    $children = @{}
    foreach ($p in $procs) {
        if (-not $children.ContainsKey($p.Ppid)) { $children[$p.Ppid] = New-Object System.Collections.Generic.List[object] }
        $children[$p.Ppid].Add($p)
    }
    $queue = New-Object System.Collections.Generic.Queue[uint32]
    $queue.Enqueue([uint32]$RootPid)
    $desc = New-Object System.Collections.Generic.List[object]
    $visited = @{}
    while ($queue.Count -gt 0) {
        $cur = $queue.Dequeue()
        if ($visited.ContainsKey($cur)) { continue }
        $visited[$cur] = $true
        if ($children.ContainsKey($cur)) {
            foreach ($c in $children[$cur]) {
                if ($c.Pid -eq $self -or $c.Pid -eq $cur) { continue }
                $desc.Add($c); $queue.Enqueue($c.Pid)
            }
        }
    }
    $now = Get-Date
    foreach ($p in $desc) {
        $key = [string]$p.Pid
        if ($lastProbe.ContainsKey($key) -and ($now - $lastProbe[$key]).TotalMilliseconds -lt 1000) { continue }
        $lastProbe[$key] = $now
        $state = [ConsoleWatch]::Probe($p.Pid)
        if (-not $lastState.ContainsKey($key) -or $lastState[$key] -ne $state) {
            $lastState[$key] = $state
            $names[$key] = $p.Exe
            Emit @{ kind = 'console'; pid = $p.Pid; ppid = $p.Ppid; exe = $p.Exe; state = $state }
        }
    }
    foreach ($w in [ConsoleWatch]::VisibleConsoleWindows()) {
        if ($baseline.ContainsKey($w) -or $seenWindows.ContainsKey($w)) { continue }
        $seenWindows[$w] = $true
        $parts = $w -split '\|'
        Emit @{ kind = 'visible_console_window'; hwnd = $parts[0]; class = $parts[1]; owner_pid = [int]$parts[2]; owner_exe = $names[$parts[2]] }
    }
    Start-Sleep -Milliseconds 150
}
Emit @{ kind = 'stop'; processes_seen = $lastState.Count; new_visible_console_windows = $seenWindows.Count }
