using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace WhisperAero;

public sealed class PeerMeta
{
    public string Name { get; set; } = "Whisper";
    public string Avatar { get; set; } = string.Empty;
    public bool Muted { get; set; }
}

public sealed class StoredSession
{
    public string SupabaseUrl { get; set; } = string.Empty;
    public string AnonKey { get; set; } = string.Empty;
    public string AccessToken { get; set; } = string.Empty;
    public string RefreshToken { get; set; } = string.Empty;
    public long ExpiresAt { get; set; }
    public string UserId { get; set; } = string.Empty;
    public Dictionary<string, PeerMeta> Chats { get; set; } = new();
    public string LastSeenIso { get; set; } = string.Empty;
}

public sealed class AppPrefs
{
    public bool MinimizeToTray { get; set; } = true;
}

public static class NativePrefs
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunValueName = "Whisper";

    private static readonly string AppDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "WhisperAero");
    private static readonly string PrefsPath = Path.Combine(AppDir, "prefs.json");
    private static readonly string SessionPath = Path.Combine(AppDir, "session.json");
    private static readonly SemaphoreSlim SessionLock = new(1, 1);

    public static string AvatarCacheDir { get; } = Path.Combine(AppDir, "AvatarCache");

    public static AppPrefs LoadPrefs()
    {
        try
        {
            if (File.Exists(PrefsPath))
            {
                var json = File.ReadAllText(PrefsPath);
                return JsonSerializer.Deserialize<AppPrefs>(json) ?? new AppPrefs();
            }
        }
        catch
        {
        }
        return new AppPrefs();
    }

    public static void SavePrefs(AppPrefs prefs)
    {
        try
        {
            Directory.CreateDirectory(AppDir);
            File.WriteAllText(PrefsPath, JsonSerializer.Serialize(prefs));
        }
        catch
        {
        }
    }

    public static bool IsStartupEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, false);
            return key?.GetValue(RunValueName) is string s && !string.IsNullOrWhiteSpace(s);
        }
        catch
        {
            return false;
        }
    }

    public static void SetStartupEnabled(bool enabled)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, true)
                            ?? Registry.CurrentUser.CreateSubKey(RunKeyPath, true);
            if (key == null) return;
            if (enabled)
            {
                var exePath = Environment.ProcessPath;
                if (!string.IsNullOrWhiteSpace(exePath))
                {
                    key.SetValue(RunValueName, $"\"{exePath}\"");
                }
            }
            else
            {
                key.DeleteValue(RunValueName, false);
            }
        }
        catch
        {
        }
    }

    public static StoredSession? LoadSession()
    {
        try
        {
            if (!File.Exists(SessionPath)) return null;
            var s = JsonSerializer.Deserialize<StoredSession>(File.ReadAllText(SessionPath));
            if (s == null || string.IsNullOrWhiteSpace(s.SupabaseUrl) || string.IsNullOrWhiteSpace(s.AccessToken) || string.IsNullOrWhiteSpace(s.UserId))
            {
                return null;
            }
            return s;
        }
        catch
        {
            return null;
        }
    }

    public static StoredSession? SaveSessionFromBridge(JsonElement root)
    {
        try
        {
            var supabaseUrl = root.TryGetProperty("supabaseUrl", out var u) ? (u.GetString() ?? "").Trim().TrimEnd('/') : "";
            var anonKey = root.TryGetProperty("anonKey", out var k) ? (k.GetString() ?? "").Trim() : "";
            var accessToken = root.TryGetProperty("accessToken", out var a) ? (a.GetString() ?? "").Trim() : "";
            var refreshToken = root.TryGetProperty("refreshToken", out var r) ? (r.GetString() ?? "").Trim() : "";
            var expiresAt = root.TryGetProperty("expiresAt", out var e) && e.TryGetInt64(out var exp) ? exp : 0L;
            var userId = root.TryGetProperty("userId", out var uid) ? (uid.GetString() ?? "").Trim() : "";

            if (string.IsNullOrWhiteSpace(supabaseUrl) || string.IsNullOrWhiteSpace(anonKey) ||
                string.IsNullOrWhiteSpace(accessToken) || string.IsNullOrWhiteSpace(userId))
            {
                return null;
            }

            var existing = LoadSession();
            var chats = new Dictionary<string, PeerMeta>();
            if (root.TryGetProperty("chats", out var arr) && arr.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in arr.EnumerateArray())
                {
                    var id = item.TryGetProperty("id", out var cid) ? (cid.GetString() ?? "") : "";
                    if (string.IsNullOrWhiteSpace(id)) continue;
                    var name = item.TryGetProperty("name", out var nm) ? (nm.GetString() ?? "Whisper") : "Whisper";
                    var avatar = item.TryGetProperty("avatar", out var av) ? (av.GetString() ?? "") : "";
                    var muted = item.TryGetProperty("muted", out var mt) && mt.ValueKind == JsonValueKind.True;
                    chats[id] = new PeerMeta { Name = string.IsNullOrWhiteSpace(name) ? "Whisper" : name, Avatar = avatar, Muted = muted };
                }
            }

            var session = new StoredSession
            {
                SupabaseUrl = supabaseUrl,
                AnonKey = anonKey,
                AccessToken = accessToken,
                RefreshToken = refreshToken,
                ExpiresAt = expiresAt,
                UserId = userId,
                Chats = chats,
                LastSeenIso = existing?.UserId == userId ? existing.LastSeenIso : DateTimeOffset.UtcNow.ToString("O"),
            };

            Directory.CreateDirectory(AppDir);
            File.WriteAllText(SessionPath, JsonSerializer.Serialize(session));
            return session;
        }
        catch
        {
            return null;
        }
    }

    public static void SaveLastSeenIso(string iso)
    {
        if (string.IsNullOrWhiteSpace(iso)) return;
        try
        {
            var s = LoadSession();
            if (s == null) return;
            s.LastSeenIso = iso;
            Directory.CreateDirectory(AppDir);
            File.WriteAllText(SessionPath, JsonSerializer.Serialize(s));
        }
        catch
        {
        }
    }

    public static void ClearSession()
    {
        try
        {
            if (File.Exists(SessionPath)) File.Delete(SessionPath);
        }
        catch
        {
        }
    }

    public static async Task<StoredSession?> RefreshAccessTokenIfNeededAsync(HttpClient http)
    {
        var current = LoadSession();
        if (current == null) return null;
        var nowSec = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (current.ExpiresAt > 0 && current.ExpiresAt - nowSec > 90) return current;
        if (string.IsNullOrWhiteSpace(current.RefreshToken)) return current;

        await SessionLock.WaitAsync();
        try
        {
            current = LoadSession();
            if (current == null) return null;
            nowSec = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            if (current.ExpiresAt > 0 && current.ExpiresAt - nowSec > 90) return current;

            using var req = new HttpRequestMessage(
                HttpMethod.Post,
                $"{current.SupabaseUrl}/auth/v1/token?grant_type=refresh_token");
            req.Headers.TryAddWithoutValidation("apikey", current.AnonKey);
            req.Content = new StringContent(
                JsonSerializer.Serialize(new { refresh_token = current.RefreshToken }),
                Encoding.UTF8,
                "application/json");

            using var resp = await http.SendAsync(req);
            if (!resp.IsSuccessStatusCode) return current;
            using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
            var root = doc.RootElement;
            var newAccess = root.TryGetProperty("access_token", out var at) ? (at.GetString() ?? "") : "";
            var newRefresh = root.TryGetProperty("refresh_token", out var rt) ? (rt.GetString() ?? "") : "";
            var expiresIn = root.TryGetProperty("expires_in", out var ei) && ei.TryGetInt64(out var eSec) ? eSec : 3600L;
            var newExp = root.TryGetProperty("expires_at", out var ea) && ea.TryGetInt64(out var eaVal)
                ? eaVal
                : DateTimeOffset.UtcNow.ToUnixTimeSeconds() + expiresIn;
            if (string.IsNullOrWhiteSpace(newAccess)) return current;

            current.AccessToken = newAccess;
            if (!string.IsNullOrWhiteSpace(newRefresh)) current.RefreshToken = newRefresh;
            current.ExpiresAt = newExp;
            Directory.CreateDirectory(AppDir);
            File.WriteAllText(SessionPath, JsonSerializer.Serialize(current));
            return current;
        }
        catch
        {
            return current;
        }
        finally
        {
            SessionLock.Release();
        }
    }
}
