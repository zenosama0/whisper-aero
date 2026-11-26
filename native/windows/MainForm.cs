using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Toolkit.Uwp.Notifications;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace WhisperAero;

public sealed class MainForm : Form
{
    private const string AppUrl = "https://zenosama0.github.io/whisper-aero/";
    private const int DwmwaUseImmersiveDarkMode = 20;
    private const uint FlashwAll = 3;
    private const uint FlashwTimerNoFg = 12;

    private readonly WebView2 _webView;
    private readonly NotifyIcon _trayIcon;
    private readonly NativeNotifier _notifier;
    private readonly BackgroundSyncService _bgSync;
    private readonly AppPrefs _prefs;
    private EventWaitHandle? _activateEvent;
    private bool _allowExit;

    [StructLayout(LayoutKind.Sequential)]
    private struct FLASHWINFO
    {
        public uint cbSize;
        public IntPtr hwnd;
        public uint dwFlags;
        public uint uCount;
        public uint dwTimeout;
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    [DllImport("user32.dll")]
    private static extern bool FlashWindowEx(ref FLASHWINFO pwfi);

    public MainForm()
    {
        _prefs = NativePrefs.LoadPrefs();

        Text = "Whisper";
        Width = 1180;
        Height = 780;
        MinimumSize = new Size(420, 580);
        StartPosition = FormStartPosition.CenterScreen;

        var exeIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
        Icon = exeIcon;

        var trayMenu = new ContextMenuStrip();
        trayMenu.Items.Add("Open Whisper", null, (_, _) => RestoreWindow());
        trayMenu.Items.Add("Quit Whisper", null, (_, _) => ExitApp());

        _trayIcon = new NotifyIcon
        {
            Icon = exeIcon,
            Text = "Whisper",
            Visible = true,
            ContextMenuStrip = trayMenu,
        };
        _trayIcon.DoubleClick += (_, _) => RestoreWindow();

        _notifier = new NativeNotifier(_trayIcon);
        _bgSync = new BackgroundSyncService();

        _notifier.OpenChatRequested += chatId =>
        {
            BeginInvoke(() =>
            {
                RestoreWindow();
                if (!string.IsNullOrEmpty(chatId)) OpenChatInWeb(chatId);
            });
        };

        _notifier.QuickReplySubmitted += (chatId, text) =>
        {
            _ = Task.Run(async () =>
            {
                await _bgSync.SendQuickReplyAsync(chatId, text);
                _notifier.ClearChat(chatId);
            });
        };

        _notifier.MarkReadRequested += chatId =>
        {
            _ = Task.Run(async () =>
            {
                await _bgSync.MarkConversationReadAsync(chatId);
                _notifier.ClearChat(chatId);
            });
        };

        _trayIcon.BalloonTipClicked += (_, _) =>
        {
            RestoreWindow();
            if (!string.IsNullOrEmpty(_notifier.LastNotifiedChatId))
            {
                OpenChatInWeb(_notifier.LastNotifiedChatId);
            }
        };

        _bgSync.NotificationReceived += (convId, title, body, iconUrl, tag, msgId) =>
        {
            BeginInvoke(async () =>
            {
                if (IsAppFocused()) return;
                FlashTaskbar();
                await _notifier.ShowAsync(convId, title, body, iconUrl, tag, msgId);
            });
        };

        _webView = new WebView2 { Dock = DockStyle.Fill };
        Controls.Add(_webView);

        Load += async (_, _) => await InitializeWebViewAsync();
        FormClosing += OnFormClosing;
        Activated += (_, _) =>
        {
            if (_webView.CoreWebView2 != null)
            {
                _ = _webView.CoreWebView2.ExecuteScriptAsync(
                    "if(typeof window.WhisperOnNativeResume==='function') window.WhisperOnNativeResume();");
            }
        };

        StartSingleInstanceListener();
        _bgSync.StartOrRestart();
    }

    private void StartSingleInstanceListener()
    {
        try
        {
            _activateEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ActivateEventName);
            var thread = new Thread(() =>
            {
                while (!_allowExit && _activateEvent != null)
                {
                    try
                    {
                        _activateEvent.WaitOne();
                        if (_allowExit) break;
                        BeginInvoke(RestoreWindow);
                    }
                    catch
                    {
                        break;
                    }
                }
            })
            {
                IsBackground = true,
            };
            thread.Start();
        }
        catch
        {
        }
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            var userDataDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "WhisperAero",
                "WebView2");
            Directory.CreateDirectory(userDataDir);

            var env = await CoreWebView2Environment.CreateAsync(null, userDataDir);
            await _webView.EnsureCoreWebView2Async(env);

            var core = _webView.CoreWebView2;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = true;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.UserAgent = core.Settings.UserAgent.Replace("; wv", string.Empty);

            core.PermissionRequested += (_, args) =>
            {
                if (Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri) &&
                    uri.Host.Equals("zenosama0.github.io", StringComparison.OrdinalIgnoreCase))
                {
                    args.State = CoreWebView2PermissionState.Allow;
                }
            };

            core.NewWindowRequested += (_, args) =>
            {
                if (Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri) && !IsInAppHost(uri.Host))
                {
                    args.Handled = true;
                    OpenExternalUrl(args.Uri);
                }
            };

            core.NavigationStarting += (_, args) =>
            {
                if (Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri) && !IsInAppHost(uri.Host))
                {
                    args.Cancel = true;
                    OpenExternalUrl(args.Uri);
                }
            };

            core.NavigationCompleted += (_, _) => PushNativeStateToWeb();
            core.WebMessageReceived += (_, args) => HandleWebMessage(args.WebMessageAsJson);

            core.Navigate(AppUrl);
        }
        catch (Exception ex)
        {
            var choice = MessageBox.Show(
                $"Whisper requires the Microsoft Edge WebView2 Runtime.\n\nDetails: {ex.Message}\n\nOpen Microsoft's WebView2 installer page now?",
                "Whisper",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning);
            if (choice == DialogResult.Yes)
            {
                OpenExternalUrl("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
            }
            ExitApp();
        }
    }

    private void PushNativeStateToWeb()
    {
        if (_webView.CoreWebView2 == null) return;
        var payload = JsonSerializer.Serialize(new
        {
            platform = "windows",
            notificationsGranted = true,
            launchOnStartup = NativePrefs.IsStartupEnabled(),
            minimizeToTray = _prefs.MinimizeToTray,
        });
        _ = _webView.CoreWebView2.ExecuteScriptAsync(
            $"if(typeof window.WhisperOnNativeState==='function') window.WhisperOnNativeState({payload});");
    }

    private async void HandleWebMessage(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (!root.TryGetProperty("type", out var typeEl)) return;
            var msgType = typeEl.GetString() ?? string.Empty;

            switch (msgType)
            {
                case "notify":
                {
                    if (IsAppFocused()) break;
                    var title = root.TryGetProperty("title", out var t) ? (t.GetString() ?? "Whisper") : "Whisper";
                    var body = root.TryGetProperty("body", out var b) ? (b.GetString() ?? "New message") : "New message";
                    var convId = root.TryGetProperty("conversationId", out var c) ? (c.GetString() ?? "") : "";
                    var icon = root.TryGetProperty("icon", out var ic) ? (ic.GetString() ?? "") : "";
                    var tag = root.TryGetProperty("tag", out var tg) ? (tg.GetString() ?? "whisper") : "whisper";
                    var messageId = root.TryGetProperty("messageId", out var mid) ? (mid.GetString() ?? "") : "";
                    FlashTaskbar();
                    await _notifier.ShowAsync(convId, title, body, icon, tag, messageId);
                    break;
                }
                case "testNotification":
                {
                    await _notifier.ShowAsync("", "Whisper Native Alerts", "Windows Toasts & Quick Reply are working!", "", "whisper-test");
                    break;
                }
                case "clearNotification":
                {
                    var chatId = root.TryGetProperty("conversationId", out var c) ? (c.GetString() ?? "") : "";
                    if (!string.IsNullOrEmpty(chatId)) _notifier.ClearChat(chatId);
                    break;
                }
                case "theme":
                {
                    var theme = root.TryGetProperty("theme", out var th) ? (th.GetString() ?? "aero") : "aero";
                    ApplyNativeTitleBarTheme(theme == "dark");
                    break;
                }
                case "syncSession":
                {
                    if (root.TryGetProperty("payload", out var payloadEl))
                    {
                        var hadSession = NativePrefs.LoadSession() != null;
                        var saved = NativePrefs.SaveSessionFromBridge(payloadEl);
                        if (saved != null && !hadSession)
                        {
                            _bgSync.StartOrRestart();
                        }
                    }
                    PushNativeStateToWeb();
                    break;
                }
                case "clearSession":
                {
                    NativePrefs.ClearSession();
                    _bgSync.Stop();
                    break;
                }
                case "setStartup":
                {
                    var enabled = root.TryGetProperty("enabled", out var en) && en.ValueKind == JsonValueKind.True;
                    NativePrefs.SetStartupEnabled(enabled);
                    PushNativeStateToWeb();
                    break;
                }
                case "setMinimizeToTray":
                {
                    var enabled = !root.TryGetProperty("enabled", out var en) || en.ValueKind != JsonValueKind.False;
                    _prefs.MinimizeToTray = enabled;
                    NativePrefs.SavePrefs(_prefs);
                    PushNativeStateToWeb();
                    break;
                }
                case "copy":
                {
                    var text = root.TryGetProperty("text", out var tx) ? (tx.GetString() ?? "") : "";
                    if (!string.IsNullOrEmpty(text)) Clipboard.SetText(text);
                    break;
                }
            }
        }
        catch
        {
        }
    }

    private bool IsAppFocused()
    {
        return Visible && WindowState != FormWindowState.Minimized && ContainsFocus;
    }

    private void FlashTaskbar()
    {
        if (!IsHandleCreated || !Visible) return;
        var info = new FLASHWINFO
        {
            cbSize = (uint)Marshal.SizeOf<FLASHWINFO>(),
            hwnd = Handle,
            dwFlags = FlashwAll | FlashwTimerNoFg,
            uCount = 3,
            dwTimeout = 0,
        };
        FlashWindowEx(ref info);
    }

    private void ApplyNativeTitleBarTheme(bool dark)
    {
        if (!IsHandleCreated) return;
        int flag = dark ? 1 : 0;
        _ = DwmSetWindowAttribute(Handle, DwmwaUseImmersiveDarkMode, ref flag, sizeof(int));
        BackColor = dark ? Color.FromArgb(23, 32, 30) : Color.FromArgb(238, 246, 248);
    }

    private void OpenChatInWeb(string chatId)
    {
        if (_webView.CoreWebView2 == null) return;
        var quoted = JsonSerializer.Serialize(chatId);
        _ = _webView.CoreWebView2.ExecuteScriptAsync(
            $"if(typeof window.WhisperOpenChat==='function') window.WhisperOpenChat({quoted});");
    }

    private void RestoreWindow()
    {
        Show();
        if (WindowState == FormWindowState.Minimized)
        {
            WindowState = FormWindowState.Normal;
        }
        Activate();
    }

    private void ExitApp()
    {
        _allowExit = true;
        _bgSync.Dispose();
        _trayIcon.Visible = false;
        _trayIcon.Dispose();
        try { _activateEvent?.Set(); _activateEvent?.Dispose(); } catch { }
        Close();
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (!_allowExit && _prefs.MinimizeToTray && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        _allowExit = true;
        _bgSync.Dispose();
        _trayIcon.Visible = false;
        _trayIcon.Dispose();
        try { _activateEvent?.Set(); _activateEvent?.Dispose(); } catch { }
    }

    private static bool IsInAppHost(string host)
    {
        if (string.IsNullOrEmpty(host)) return true;
        return host.Equals("zenosama0.github.io", StringComparison.OrdinalIgnoreCase) ||
               host.EndsWith(".supabase.co", StringComparison.OrdinalIgnoreCase) ||
               host.Equals("accounts.google.com", StringComparison.OrdinalIgnoreCase) ||
               host.EndsWith(".google.com", StringComparison.OrdinalIgnoreCase) ||
               host.EndsWith(".gstatic.com", StringComparison.OrdinalIgnoreCase) ||
               host.EndsWith(".googleusercontent.com", StringComparison.OrdinalIgnoreCase);
    }

    private static void OpenExternalUrl(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch
        {
        }
    }
}
