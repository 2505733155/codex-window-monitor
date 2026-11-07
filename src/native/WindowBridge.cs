using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

public static class MonitorWindowBridge
{
    [ComImport, Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A")]
    private class VirtualDesktopManager { }
    [ComImport, Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IVirtualDesktopManager
    {
        [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr window, [MarshalAs(UnmanagedType.Bool)] out bool current);
        [PreserveSig] int GetWindowDesktopId(IntPtr window, out Guid desktop);
        [PreserveSig] int MoveWindowToDesktop(IntPtr window, ref Guid desktop);
    }
    private delegate bool EnumCallback(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback callback, IntPtr data);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();

    public class WindowInfo
    {
        public long Handle;
        public uint ProcessId;
        public string ProcessStarted;
        public string Title;
        public string DesktopId;
        public string DesktopLabel;
        public bool OnCurrentDesktop;
        public bool Minimized;
        public bool Foreground;
    }
    public class ActivationResult
    {
        public bool Activated;
        public bool DesktopUnchanged;
        public WindowInfo Window;
    }
    private static string DesktopLabel(Guid desktop)
    {
        string label = desktop == Guid.Empty ? "\u684c\u9762\u672a\u8bc6\u522b" : "\u684c\u9762 " + desktop.ToString().Substring(0, 8);
        try
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops"))
            {
                byte[] ids = key == null ? null : key.GetValue("VirtualDesktopIDs") as byte[];
                if (ids != null)
                {
                    for (int i = 0; i + 16 <= ids.Length; i += 16)
                    {
                        byte[] value = new byte[16]; Array.Copy(ids, i, value, 0, 16);
                        if (new Guid(value) == desktop) { label = "\u684c\u9762 " + (i / 16 + 1).ToString(CultureInfo.InvariantCulture); break; }
                    }
                }
                using (RegistryKey named = key == null ? null : key.OpenSubKey("Desktops\\" + desktop.ToString("B")))
                {
                    string name = named == null ? null : named.GetValue("Name") as string;
                    if (!String.IsNullOrWhiteSpace(name)) label += " \u00b7 " + name;
                }
            }
        }
        catch (System.Security.SecurityException) { }
        catch (UnauthorizedAccessException) { }
        return label;
    }
    private static WindowInfo ReadWindow(IntPtr window)
    {
        if (!IsWindow(window) || GetAncestor(window, 2) != window || !IsWindowVisible(window)) throw new InvalidOperationException("Window is unavailable");
        StringBuilder className = new StringBuilder(256); GetClassName(window, className, className.Capacity);
        if (className.ToString() != "Chrome_WidgetWin_1") throw new InvalidOperationException("Not a VS Code window");
        uint processId; GetWindowThreadProcessId(window, out processId);
        WindowInfo info = new WindowInfo(); info.Handle = window.ToInt64(); info.ProcessId = processId;
        using (Process process = Process.GetProcessById((int)processId))
        {
            if (!String.Equals(process.ProcessName, "Code", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Not a VS Code process");
            info.ProcessStarted = process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
        }
        StringBuilder title = new StringBuilder(2048); GetWindowText(window, title, title.Capacity); info.Title = title.ToString();
        if (info.Title.Length == 0) throw new InvalidOperationException("Window has no title");
        info.Minimized = IsIconic(window); info.Foreground = GetAncestor(GetForegroundWindow(), 2) == window;
        IVirtualDesktopManager manager = (IVirtualDesktopManager)new VirtualDesktopManager();
        try
        {
            Guid desktop; bool current;
            int desktopStatus = manager.GetWindowDesktopId(window, out desktop);
            int currentStatus = manager.IsWindowOnCurrentVirtualDesktop(window, out current);
            info.DesktopId = desktopStatus == 0 ? desktop.ToString() : "";
            info.DesktopLabel = DesktopLabel(desktopStatus == 0 ? desktop : Guid.Empty);
            info.OnCurrentDesktop = currentStatus == 0 && current;
        }
        finally { Marshal.ReleaseComObject(manager); }
        return info;
    }
    public static WindowInfo[] List()
    {
        List<WindowInfo> windows = new List<WindowInfo>();
        EnumWindows(delegate(IntPtr window, IntPtr data)
        {
            try { windows.Add(ReadWindow(window)); }
            catch (ArgumentException) { }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception) { }
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }
    private static WindowInfo WaitForActivation(IntPtr window, int attempts)
    {
        WindowInfo info = null;
        for (int i = 0; i < attempts; i++)
        {
            Thread.Sleep(75); info = ReadWindow(window);
            if (info.Foreground && info.OnCurrentDesktop) break;
        }
        return info;
    }
    public static ActivationResult Activate(long handle, uint processId, string processStarted, string expectedTitle)
    {
        IntPtr window = new IntPtr(handle); WindowInfo before = ReadWindow(window);
        if (before.ProcessId != processId || before.ProcessStarted != processStarted || before.Title != expectedTitle) throw new InvalidOperationException("Window changed; select it again");
        if (before.Minimized) { ShowWindowAsync(window, 9); Thread.Sleep(100); }
        SetForegroundWindow(window); WindowInfo after = WaitForActivation(window, 8);
        if (!after.Foreground || !after.OnCurrentDesktop)
        {
            uint foregroundPid;
            uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out foregroundPid);
            uint callerThread = GetCurrentThreadId(); bool attached = false;
            try
            {
                if (foregroundThread != 0 && foregroundThread != callerThread) attached = AttachThreadInput(callerThread, foregroundThread, true);
                BringWindowToTop(window); SetForegroundWindow(window);
            }
            finally { if (attached) AttachThreadInput(callerThread, foregroundThread, false); }
            after = WaitForActivation(window, 12);
        }
        bool sameDesktop = before.DesktopId.Length > 0 && before.DesktopId == after.DesktopId;
        bool sameWindow = before.ProcessId == after.ProcessId && before.ProcessStarted == after.ProcessStarted && before.Title == after.Title;
        return new ActivationResult { Activated = after.Foreground && after.OnCurrentDesktop && sameDesktop && sameWindow, DesktopUnchanged = sameDesktop, Window = after };
    }
}
