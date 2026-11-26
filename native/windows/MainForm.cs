using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace WhisperAero;

public sealed class MainForm : Form
{
    private const string AppUrl = "https://zenosama0.github.io/whisper-aero/";
    private const int DwmwaUseImmersiveDarkMode = 20;

    private readonly WebView2 _webView;
    private readonly NotifyIcon _trayIcon;
    private bool _allowExit;
    private string _lastNotifyChatId = string.Empty;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    public MainForm()
    {
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
        _trayIcon.BalloonTipClicked += (_, _) =>
        {
            RestoreWindow();
            if (!string.IsNullOrEmpty(_lastNotifyChatId))
            {
                OpenChatInWeb(_lastNotifyChatId);
            }
        };

        _webView = new WebView2
        {
            Dock = DockStyle.Fill,
        };
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

    private void HandleWebMessage(string json)
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
                    var title = root.TryGetProperty("title", out var t) ? (t.GetString() ?? "Whisper") : "Whisper";
                    var body = root.TryGetProperty("body", out var b) ? (b.GetString() ?? "New message") : "New message";
                    _lastNotifyChatId = root.TryGetProperty("conversationId", out var c)
                        ? (c.GetString() ?? string.Empty)
                        : string.Empty;

                    _trayIcon.BalloonTipTitle = string.IsNullOrWhiteSpace(title) ? "Whisper" : title;
                    _trayIcon.BalloonTipText = string.IsNullOrWhiteSpace(body) ? "New message" : body;
                    _trayIcon.BalloonTipIcon = ToolTipIcon.Info;
                    _trayIcon.ShowBalloonTip(5000);
                    break;
                }
                case "clearNotification":
                {
                    var chatId = root.TryGetProperty("conversationId", out var c) ? (c.GetString() ?? string.Empty) : string.Empty;
                    if (!string.IsNullOrEmpty(chatId) && chatId == _lastNotifyChatId)
                    {
                        _lastNotifyChatId = string.Empty;
                    }
                    break;
                }
                case "theme":
                {
                    var theme = root.TryGetProperty("theme", out var th) ? (th.GetString() ?? "aero") : "aero";
                    ApplyNativeTitleBarTheme(theme == "dark");
                    break;
                }
            }
        }
        catch
        {
            // Ignore malformed bridge payloads
        }
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
        _trayIcon.Visible = false;
        _trayIcon.Dispose();
        Close();
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (!_allowExit && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        _trayIcon.Visible = false;
        _trayIcon.Dispose();
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
            // Ignore shell launch failures
        }
    }
}
