$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32;

public sealed class DevHotelHostInputSnapshot
{
    public int CursorX { get; set; }
    public int CursorY { get; set; }
    public long ForegroundWindow { get; set; }
    public int PressedKeyCount { get; set; }
    public bool InteractiveDesktop { get; set; }
}

public sealed class DevHotelHostInputMonitorReport
{
    public DevHotelHostInputSnapshot Baseline { get; set; }
    public DevHotelHostInputSnapshot Final { get; set; }
    public bool MouseActivity { get; set; }
    public bool MouseActivityInjected { get; set; }
    public bool CursorMoved { get; set; }
    public int FirstCursorX { get; set; }
    public int FirstCursorY { get; set; }
    public bool ForegroundChanged { get; set; }
    public long FirstForegroundWindow { get; set; }
    public bool KeyboardChanged { get; set; }
    public bool KeyboardActivityInjected { get; set; }
}

public static class DevHotelHostInputMonitor
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;
    private const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    private const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    private const uint WINEVENT_SKIPOWNPROCESS = 0x0002;
    private const uint WM_TIMER = 0x0113;
    private const uint WM_STOP = 0x8001;
    private const uint PM_NOREMOVE = 0x0000;
    private const uint DESKTOP_READOBJECTS = 0x0001;
    private const uint LLMHF_INJECTED = 0x00000001;
    private const uint LLMHF_LOWER_IL_INJECTED = 0x00000002;
    private const uint LLKHF_LOWER_IL_INJECTED = 0x00000002;
    private const uint LLKHF_INJECTED = 0x00000010;
    private const ulong STOP_DRAIN_MS = 250;
    private static readonly ulong MaxPumpGapMs = ReadLowLevelHooksTimeoutMs();

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        public IntPtr Window;
        public uint Id;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public Point Cursor;
        public uint Private;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseHookData
    {
        public Point Cursor;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardHookData
    {
        public uint VirtualKey;
        public uint ScanCode;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate IntPtr HookProcedure(int code, UIntPtr message, IntPtr data);

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate void WinEventProcedure(
        IntPtr hook,
        uint eventType,
        IntPtr window,
        int objectId,
        int childId,
        uint eventThread,
        uint eventTime);

    private static readonly HookProcedure MouseProcedure = ObserveMouse;
    private static readonly HookProcedure KeyboardProcedure = ObserveKeyboard;
    private static readonly WinEventProcedure ForegroundProcedure = ObserveForeground;

    private static DevHotelHostInputMonitorReport Report;
    private static IntPtr MouseHook;
    private static IntPtr KeyboardHook;
    private static IntPtr ForegroundHook;
    private static UIntPtr PollTimer;
    private static Exception CallbackError;
    // Used only as an in-process state backstop. Event/message/key identities
    // are never copied into the wire report.
    private static bool[] BaselineKeys;
    private static bool StartSet;
    private static uint StartTime;
    private static bool CutoffSet;
    private static uint CutoffTime;

    [DllImport("user32.dll", EntryPoint = "SetWindowsHookExW", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int hookType, HookProcedure procedure, IntPtr module, uint threadId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hook);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hook, int code, UIntPtr message, IntPtr data);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWinEventHook(
        uint eventMin,
        uint eventMax,
        IntPtr module,
        WinEventProcedure procedure,
        uint processId,
        uint threadId,
        uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWinEvent(IntPtr hook);

    [DllImport("user32.dll", EntryPoint = "GetMessageW", SetLastError = true)]
    private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);

    [DllImport("user32.dll", EntryPoint = "TranslateMessage")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TranslateMessage(ref Message message);

    [DllImport("user32.dll", EntryPoint = "DispatchMessageW")]
    private static extern IntPtr DispatchMessage(ref Message message);

    [DllImport("user32.dll", EntryPoint = "PeekMessageW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint remove);

    [DllImport("user32.dll", EntryPoint = "PostThreadMessageW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostThreadMessage(uint threadId, uint message, UIntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern UIntPtr SetTimer(IntPtr window, UIntPtr timerId, uint intervalMs, IntPtr callback);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool KillTimer(IntPtr window, UIntPtr timerId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetCursorPos(out Point point);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int virtualKey);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint flags, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint access);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseDesktop(IntPtr desktop);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("kernel32.dll")]
    private static extern uint GetTickCount();

    [DllImport("kernel32.dll")]
    private static extern ulong GetTickCount64();

    [DllImport("kernel32.dll", EntryPoint = "GetModuleHandleW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string moduleName);

    public static DevHotelHostInputMonitorReport Run()
    {
        StartSet = false;
        CutoffSet = false;
        CallbackError = null;
        uint monitorThread = GetCurrentThreadId();
        Message ignored;
        PeekMessage(out ignored, IntPtr.Zero, 0, 0, PM_NOREMOVE);

        EnsureInteractiveDesktop();
        DevHotelHostInputSnapshot baseline = CaptureSnapshot(out BaselineKeys);
        Report = new DevHotelHostInputMonitorReport();
        Report.Baseline = baseline;

        Exception cleanupError = null;
        try
        {
            // From the first low-level hook onward, any gap at least as long
            // as LowLevelHooksTimeout makes the hook lifetime unprovable.
            // Include the complete arming interval instead of resetting this
            // clock at READY.
            ulong lastPump = GetTickCount64();
            IntPtr module = GetModuleHandle(null);
            ThrowIfZero(module, "resolve the Host input observation module");
            MouseHook = SetWindowsHookEx(WH_MOUSE_LL, MouseProcedure, module, 0);
            ThrowIfZero(MouseHook, "install the Host mouse observation hook");

            KeyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, KeyboardProcedure, module, 0);
            ThrowIfZero(KeyboardHook, "install the Host keyboard observation hook");

            ForegroundHook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                IntPtr.Zero,
                ForegroundProcedure,
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
            ThrowIfZero(ForegroundHook, "install the Host foreground observation hook");

            PollTimer = SetTimer(IntPtr.Zero, UIntPtr.Zero, 10, IntPtr.Zero);
            if (PollTimer == UIntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not start the Host input observation timer");
            }

            // Tests cannot start until READY. Reset the baseline and every
            // latch after installation, so only the fully armed interval is
            // claimed as observed.
            baseline = CaptureSnapshot(out BaselineKeys);
            Report = new DevHotelHostInputMonitorReport();
            Report.Baseline = baseline;
            CallbackError = null;
            StartSet = false;
            CutoffSet = false;

            Thread stopReader = new Thread(delegate()
            {
                try
                {
                    Console.In.ReadLine();
                }
                finally
                {
                    if (!PostThreadMessage(monitorThread, WM_STOP, UIntPtr.Zero, IntPtr.Zero))
                    {
                        Console.Error.WriteLine(
                            new Win32Exception(Marshal.GetLastWin32Error(), "Could not stop the Host input observation loop"));
                        Environment.Exit(2);
                    }
                }
            });
            stopReader.IsBackground = true;
            stopReader.Name = "DevHotel host-input monitor stop reader";
            stopReader.Start();

            ulong readyAt = GetTickCount64();
            ThrowIfPumpGapExceeded(lastPump, readyAt);
            lastPump = readyAt;
            StartTime = GetTickCount();
            StartSet = true;
            Console.Out.WriteLine("READY\t" + SnapshotJson(baseline));
            Console.Out.Flush();

            bool stopping = false;
            ulong stopDrainDeadline = 0;
            while (true)
            {
                Message message;
                int status = GetMessage(out message, IntPtr.Zero, 0, 0);
                if (status == -1)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Host input observation message loop failed");
                }
                ulong now = GetTickCount64();
                ThrowIfPumpGapExceeded(lastPump, now);
                lastPump = now;
                ThrowCallbackError();
                if (status == 0)
                {
                    throw new InvalidOperationException("Host input observation loop ended without an explicit stop");
                }
                if (stopping && now >= stopDrainDeadline)
                {
                    break;
                }
                if (message.Id == WM_STOP)
                {
                    if (!stopping)
                    {
                        bool[] finalKeys;
                        Report.Final = CaptureSnapshot(out finalKeys);
                        ObserveFinalSnapshot(Report.Final, finalKeys);
                        CutoffTime = GetTickCount();
                        CutoffSet = true;
                        stopDrainDeadline = GetTickCount64() + STOP_DRAIN_MS;
                        stopping = true;
                    }
                    continue;
                }
                if (message.Id == WM_TIMER)
                {
                    if (!stopping)
                    {
                        ObservePositionAndFocus();
                        ObserveKeyboardState();
                    }
                    continue;
                }
                TranslateMessage(ref message);
                DispatchMessage(ref message);
            }
        }
        finally
        {
            cleanupError = Cleanup();
        }

        if (cleanupError != null)
        {
            throw cleanupError;
        }
        return Report;
    }

    private static void EnsureInteractiveDesktop()
    {
        IntPtr desktop = OpenInputDesktop(0, false, DESKTOP_READOBJECTS);
        if (desktop == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Host input probe cannot open the interactive desktop");
        }
        if (!CloseDesktop(desktop))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Host input probe cannot close the interactive desktop handle");
        }
    }

    private static ulong ReadLowLevelHooksTimeoutMs()
    {
        const ulong defaultTimeoutMs = 300;
        try
        {
            object configured = Registry.GetValue(
                @"HKEY_CURRENT_USER\Control Panel\Desktop",
                "LowLevelHooksTimeout",
                defaultTimeoutMs);
            ulong parsed;
            if (configured != null
                && UInt64.TryParse(Convert.ToString(configured, CultureInfo.InvariantCulture), out parsed)
                && parsed > 0)
            {
                return Math.Min(parsed, 1000);
            }
        }
        catch
        {
            // A missing or unreadable value uses Windows' documented default.
        }
        return defaultTimeoutMs;
    }

    private static DevHotelHostInputSnapshot CaptureSnapshot(out bool[] keys)
    {
        Point cursor;
        if (!GetCursorPos(out cursor))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Host input probe lost access to the interactive desktop");
        }

        int pressedKeyCount = CaptureKeyboardState(out keys);
        DevHotelHostInputSnapshot snapshot = new DevHotelHostInputSnapshot();
        snapshot.CursorX = cursor.X;
        snapshot.CursorY = cursor.Y;
        snapshot.ForegroundWindow = GetForegroundWindow().ToInt64();
        snapshot.PressedKeyCount = pressedKeyCount;
        snapshot.InteractiveDesktop = true;
        return snapshot;
    }

    private static void ObserveFinalSnapshot(DevHotelHostInputSnapshot snapshot, bool[] keys)
    {
        DevHotelHostInputSnapshot baseline = Report.Baseline;
        if (!Report.CursorMoved && (snapshot.CursorX != baseline.CursorX || snapshot.CursorY != baseline.CursorY))
        {
            Report.CursorMoved = true;
            Report.FirstCursorX = snapshot.CursorX;
            Report.FirstCursorY = snapshot.CursorY;
        }
        if (!Report.ForegroundChanged && snapshot.ForegroundWindow != baseline.ForegroundWindow)
        {
            Report.ForegroundChanged = true;
            Report.FirstForegroundWindow = snapshot.ForegroundWindow;
        }
        if (!Report.KeyboardChanged && KeysDiffer(BaselineKeys, keys))
        {
            Report.KeyboardChanged = true;
        }
    }

    private static void ObservePositionAndFocus()
    {
        Point cursor;
        if (!GetCursorPos(out cursor))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Host input probe lost access to the interactive desktop");
        }

        if (!Report.CursorMoved && (cursor.X != Report.Baseline.CursorX || cursor.Y != Report.Baseline.CursorY))
        {
            Report.CursorMoved = true;
            Report.FirstCursorX = cursor.X;
            Report.FirstCursorY = cursor.Y;
        }

        long foreground = GetForegroundWindow().ToInt64();
        if (!Report.ForegroundChanged && foreground != Report.Baseline.ForegroundWindow)
        {
            Report.ForegroundChanged = true;
            Report.FirstForegroundWindow = foreground;
        }
    }

    private static void ObserveKeyboardState()
    {
        if (Report.KeyboardChanged) return;
        for (int key = 1; key <= 254; key++)
        {
            bool down = (GetAsyncKeyState(key) & 0x8000) != 0;
            if (down != BaselineKeys[key])
            {
                Report.KeyboardChanged = true;
                return;
            }
        }
    }

    private static int CaptureKeyboardState(out bool[] keys)
    {
        keys = new bool[255];
        int pressedKeyCount = 0;
        for (int key = 1; key <= 254; key++)
        {
            if ((GetAsyncKeyState(key) & 0x8000) != 0)
            {
                keys[key] = true;
                pressedKeyCount++;
            }
        }
        return pressedKeyCount;
    }

    private static bool KeysDiffer(bool[] before, bool[] after)
    {
        for (int key = 1; key <= 254; key++)
        {
            if (before[key] != after[key]) return true;
        }
        return false;
    }

    private static IntPtr ObserveMouse(int code, UIntPtr message, IntPtr data)
    {
        try
        {
            if (code >= 0)
            {
                MouseHookData observed = (MouseHookData)Marshal.PtrToStructure(data, typeof(MouseHookData));
                if (ShouldRecordEvent(observed.Time))
                {
                    Report.MouseActivity = true;
                    if ((observed.Flags & (LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED)) != 0)
                    {
                        Report.MouseActivityInjected = true;
                    }
                    if (!Report.CursorMoved
                        && (observed.Cursor.X != Report.Baseline.CursorX || observed.Cursor.Y != Report.Baseline.CursorY))
                    {
                        Report.CursorMoved = true;
                        Report.FirstCursorX = observed.Cursor.X;
                        Report.FirstCursorY = observed.Cursor.Y;
                    }
                }
            }
        }
        catch (Exception error)
        {
            CallbackError = error;
        }
        return ContinueHook(MouseHook, code, message, data);
    }

    private static IntPtr ObserveKeyboard(int code, UIntPtr message, IntPtr data)
    {
        try
        {
            if (code >= 0)
            {
                KeyboardHookData observed = (KeyboardHookData)Marshal.PtrToStructure(data, typeof(KeyboardHookData));
                if (ShouldRecordEvent(observed.Time))
                {
                    Report.KeyboardChanged = true;
                    if ((observed.Flags & (LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED)) != 0)
                    {
                        Report.KeyboardActivityInjected = true;
                    }
                }
            }
        }
        catch (Exception error)
        {
            CallbackError = error;
        }
        return ContinueHook(KeyboardHook, code, message, data);
    }

    private static void ObserveForeground(
        IntPtr hook,
        uint eventType,
        IntPtr window,
        int objectId,
        int childId,
        uint eventThread,
        uint eventTime)
    {
        try
        {
            if (ShouldRecordEvent(eventTime)
                && !Report.ForegroundChanged
                && window.ToInt64() != Report.Baseline.ForegroundWindow)
            {
                Report.ForegroundChanged = true;
                Report.FirstForegroundWindow = window.ToInt64();
            }
        }
        catch (Exception error)
        {
            CallbackError = error;
        }
    }

    private static bool ShouldRecordEvent(uint eventTime)
    {
        if (StartSet && unchecked((int)(eventTime - StartTime)) < 0) return false;
        return !CutoffSet || unchecked((int)(eventTime - CutoffTime)) <= 0;
    }

    private static void ThrowIfPumpGapExceeded(ulong previous, ulong current)
    {
        ulong pumpGap = current - previous;
        if (pumpGap >= MaxPumpGapMs)
        {
            throw new InvalidOperationException(
                "Host input observation message pump stalled for " + pumpGap.ToString(CultureInfo.InvariantCulture)
                + " ms (hook timeout " + MaxPumpGapMs.ToString(CultureInfo.InvariantCulture)
                + " ms); low-level hooks can no longer be trusted");
        }
    }

    private static void ThrowCallbackError()
    {
        if (CallbackError != null)
        {
            throw new InvalidOperationException("A Host input observation callback failed", CallbackError);
        }
    }

    private static IntPtr ContinueHook(IntPtr hook, int code, UIntPtr message, IntPtr data)
    {
        try
        {
            return CallNextHookEx(hook, code, message, data);
        }
        catch (Exception error)
        {
            CallbackError = error;
            return IntPtr.Zero;
        }
    }

    private static Exception Cleanup()
    {
        Exception first = null;
        if (PollTimer != UIntPtr.Zero && !KillTimer(IntPtr.Zero, PollTimer))
        {
            first = new Win32Exception(Marshal.GetLastWin32Error(), "Could not stop the Host input observation timer");
        }
        PollTimer = UIntPtr.Zero;

        if (ForegroundHook != IntPtr.Zero && !UnhookWinEvent(ForegroundHook) && first == null)
        {
            first = new Win32Exception(Marshal.GetLastWin32Error(), "Could not remove the Host foreground observation hook");
        }
        ForegroundHook = IntPtr.Zero;

        if (KeyboardHook != IntPtr.Zero && !UnhookWindowsHookEx(KeyboardHook) && first == null)
        {
            first = new Win32Exception(Marshal.GetLastWin32Error(), "Could not remove the Host keyboard observation hook");
        }
        KeyboardHook = IntPtr.Zero;

        if (MouseHook != IntPtr.Zero && !UnhookWindowsHookEx(MouseHook) && first == null)
        {
            first = new Win32Exception(Marshal.GetLastWin32Error(), "Could not remove the Host mouse observation hook");
        }
        MouseHook = IntPtr.Zero;
        return first;
    }

    private static void ThrowIfZero(IntPtr value, string action)
    {
        if (value == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not " + action);
        }
    }

    private static string SnapshotJson(DevHotelHostInputSnapshot snapshot)
    {
        return "{\"CursorX\":" + snapshot.CursorX.ToString(CultureInfo.InvariantCulture)
            + ",\"CursorY\":" + snapshot.CursorY.ToString(CultureInfo.InvariantCulture)
            + ",\"ForegroundWindow\":" + snapshot.ForegroundWindow.ToString(CultureInfo.InvariantCulture)
            + ",\"PressedKeyCount\":" + snapshot.PressedKeyCount.ToString(CultureInfo.InvariantCulture)
            + ",\"InteractiveDesktop\":true}";
    }
}
'@

try {
    $report = [DevHotelHostInputMonitor]::Run()
    $json = ConvertTo-Json -InputObject $report -Compress -Depth 6
    [Console]::Out.WriteLine("RESULT`t$json")
    [Console]::Out.Flush()
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
}
