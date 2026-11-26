using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Toolkit.Uwp.Notifications;

namespace WhisperAero;

public sealed class NativeNotifier
{
    private readonly NotifyIcon _trayIcon;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(5) };
    private readonly Queue<string> _seenOrder = new();
    private readonly HashSet<string> _seenIds = new();
    private readonly object _dedupLock = new();

    public string LastNotifiedChatId { get; private set; } = string.Empty;

    public event Action<string>? OpenChatRequested;
    public event Action<string, string>? QuickReplySubmitted;
    public event Action<string>? MarkReadRequested;

    public NativeNotifier(NotifyIcon trayIcon)
    {
        _trayIcon = trayIcon;
        ToastNotificationManagerCompat.OnActivated += OnToastActivated;
    }

    private void OnToastActivated(ToastNotificationActivatedEventArgsCompat toastArgs)
    {
        try
        {
            var args = ToastArguments.Parse(toastArgs.Argument);
            var action = args.Contains("action") ? args["action"] : "open";
            var chatId = args.Contains("chatId") ? args["chatId"] : string.Empty;

            if (action == "reply" && !string.IsNullOrEmpty(chatId))
            {
                if (toastArgs.UserInput.TryGetValue("replyText", out var rawObj) && rawObj != null)
                {
                    var text = rawObj.ToString()?.Trim() ?? string.Empty;
                    if (!string.IsNullOrEmpty(text))
                    {
                        QuickReplySubmitted?.Invoke(chatId, text);
                        return;
                    }
                }
            }

            if (action == "markRead" && !string.IsNullOrEmpty(chatId))
            {
                MarkReadRequested?.Invoke(chatId);
                return;
            }

            OpenChatRequested?.Invoke(chatId);
        }
        catch
        {
            OpenChatRequested?.Invoke(string.Empty);
        }
    }

    public async Task ShowAsync(
        string conversationId,
        string title,
        string body,
        string iconUrl,
        string tag,
        string messageId = "")
    {
        if (!string.IsNullOrEmpty(messageId))
        {
            lock (_dedupLock)
            {
                if (!_seenIds.Add(messageId)) return;
                _seenOrder.Enqueue(messageId);
                while (_seenOrder.Count > 120)
                {
                    _seenIds.Remove(_seenOrder.Dequeue());
                }
            }
        }

        LastNotifiedChatId = conversationId;
        var cleanTitle = string.IsNullOrWhiteSpace(title) ? "Whisper" : title;
        var cleanBody = string.IsNullOrWhiteSpace(body) ? "New message" : body;
        var avatarPath = await TryCacheAvatarAsync(iconUrl);

        try
        {
            var builder = new ToastContentBuilder()
                .AddArgument("action", "open")
                .AddArgument("chatId", conversationId)
                .AddText(cleanTitle)
                .AddText(cleanBody);

            if (!string.IsNullOrEmpty(avatarPath) && File.Exists(avatarPath))
            {
                builder.AddAppLogoOverride(new Uri(avatarPath), ToastGenericAppLogoCrop.Circle);
            }

            var isCall = tag.StartsWith("whisper-call", StringComparison.OrdinalIgnoreCase);
            if (!string.IsNullOrEmpty(conversationId) && !isCall)
            {
                builder
                    .AddInputTextBox("replyText", $"Reply to {cleanTitle}…")
                    .AddButton(new ToastButton()
                        .SetContent("Reply")
                        .AddArgument("action", "reply")
                        .AddArgument("chatId", conversationId)
                        .SetBackgroundActivation())
                    .AddButton(new ToastButton()
                        .SetContent("Mark read")
                        .AddArgument("action", "markRead")
                        .AddArgument("chatId", conversationId)
                        .SetBackgroundActivation());
            }

            builder.Show(toast =>
            {
                var safeTag = string.IsNullOrWhiteSpace(conversationId) ? tag : $"c_{conversationId}";
                toast.Tag = safeTag.Length > 64 ? safeTag[..64] : safeTag;
                toast.Group = "whisper";
            });
        }
        catch
        {
            _trayIcon.BalloonTipTitle = cleanTitle;
            _trayIcon.BalloonTipText = cleanBody;
            _trayIcon.BalloonTipIcon = ToolTipIcon.Info;
            _trayIcon.ShowBalloonTip(5000);
        }
    }

    public void ClearChat(string conversationId)
    {
        if (conversationId == LastNotifiedChatId) LastNotifiedChatId = string.Empty;
        try
        {
            var safeTag = $"c_{conversationId}";
            if (safeTag.Length > 64) safeTag = safeTag[..64];
            ToastNotificationManagerCompat.History.Remove(safeTag, "whisper");
        }
        catch
        {
        }
    }

    private async Task<string?> TryCacheAvatarAsync(string url)
    {
        if (string.IsNullOrWhiteSpace(url) ||
            (!url.StartsWith("https://", StringComparison.OrdinalIgnoreCase) &&
             !url.StartsWith("http://", StringComparison.OrdinalIgnoreCase)))
        {
            return null;
        }

        try
        {
            Directory.CreateDirectory(NativePrefs.AvatarCacheDir);
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(url)))[..16];
            var filePath = Path.Combine(NativePrefs.AvatarCacheDir, $"{hash}.img");
            if (File.Exists(filePath) && (DateTime.UtcNow - File.GetLastWriteTimeUtc(filePath)).TotalHours < 12)
            {
                return filePath;
            }

            var bytes = await _http.GetByteArrayAsync(url);
            if (bytes.Length > 0)
            {
                await File.WriteAllBytesAsync(filePath, bytes);
                return filePath;
            }
        }
        catch
        {
        }
        return null;
    }
}
