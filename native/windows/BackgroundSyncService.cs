using System;
using System.IO;
using System.Net.Http;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace WhisperAero;

public sealed class BackgroundSyncService : IDisposable
{
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(15) };
    private CancellationTokenSource? _cts;
    private Task? _loopTask;
    private int _refSeq = 1;

    public event Action<string, string, string, string, string, string>? NotificationReceived;

    public void StartOrRestart()
    {
        Stop();
        var session = NativePrefs.LoadSession();
        if (session == null) return;

        _cts = new CancellationTokenSource();
        var token = _cts.Token;
        _loopTask = Task.Run(() => RunLoopAsync(token), token);
    }

    public void Stop()
    {
        try
        {
            _cts?.Cancel();
            _cts?.Dispose();
        }
        catch
        {
        }
        _cts = null;
    }

    public void Dispose() => Stop();

    private async Task RunLoopAsync(CancellationToken ct)
    {
        var backoffSec = 2;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var session = await NativePrefs.RefreshAccessTokenIfNeededAsync(_http);
                if (session == null) break;

                if (!Uri.TryCreate(session.SupabaseUrl, UriKind.Absolute, out var baseUri)) break;
                var wsUrl = $"wss://{baseUri.Host}/realtime/v1/websocket?apikey={Uri.EscapeDataString(session.AnonKey)}&vsn=1.0.0";

                using var ws = new ClientWebSocket();
                await ws.ConnectAsync(new Uri(wsUrl), ct);
                backoffSec = 2;

                await SendJsonAsync(ws, new
                {
                    topic = "realtime:whisper-win-db",
                    @event = "phx_join",
                    payload = new
                    {
                        config = new
                        {
                            postgres_changes = new object[]
                            {
                                new { @event = "INSERT", schema = "public", table = "messages" },
                                new { @event = "INSERT", schema = "public", table = "contact_requests", filter = $"receiver_id=eq.{session.UserId}" },
                                new { @event = "INSERT", schema = "public", table = "call_invites" },
                            }
                        },
                        access_token = session.AccessToken,
                    },
                    @ref = Interlocked.Increment(ref _refSeq).ToString(),
                }, ct);

                _ = Task.Run(() => CatchUpMissedMessagesAsync(session, ct), ct);

                using var hbCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                var hbTask = Task.Run(async () =>
                {
                    while (!hbCts.IsCancellationRequested && ws.State == WebSocketState.Open)
                    {
                        await Task.Delay(TimeSpan.FromSeconds(25), hbCts.Token);
                        var fresh = await NativePrefs.RefreshAccessTokenIfNeededAsync(_http);
                        await SendJsonAsync(ws, new
                        {
                            topic = "phoenix",
                            @event = "heartbeat",
                            payload = new { },
                            @ref = Interlocked.Increment(ref _refSeq).ToString(),
                        }, hbCts.Token);
                        if (fresh != null)
                        {
                            await SendJsonAsync(ws, new
                            {
                                topic = "realtime:whisper-win-db",
                                @event = "access_token",
                                payload = new { access_token = fresh.AccessToken },
                                @ref = Interlocked.Increment(ref _refSeq).ToString(),
                            }, hbCts.Token);
                        }
                    }
                }, hbCts.Token);

                var buffer = new byte[16384];
                while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
                {
                    using var ms = new MemoryStream();
                    WebSocketReceiveResult result;
                    do
                    {
                        result = await ws.ReceiveAsync(buffer, ct);
                        if (result.MessageType == WebSocketMessageType.Close) break;
                        ms.Write(buffer, 0, result.Count);
                    } while (!result.EndOfMessage);

                    if (result.MessageType == WebSocketMessageType.Close) break;
                    var msgText = Encoding.UTF8.GetString(ms.ToArray());
                    HandleRealtimeFrame(session, msgText);
                }

                hbCts.Cancel();
                try { await hbTask; } catch { }
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch
            {
            }

            try
            {
                await Task.Delay(TimeSpan.FromSeconds(backoffSec), ct);
                backoffSec = Math.Min(backoffSec * 2, 30);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private void HandleRealtimeFrame(StoredSession session, string raw)
    {
        try
        {
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            if (!root.TryGetProperty("event", out var ev) || ev.GetString() != "postgres_changes") return;
            if (!root.TryGetProperty("payload", out var pl) || !pl.TryGetProperty("data", out var data)) return;

            var table = data.TryGetProperty("table", out var tbl) ? (tbl.GetString() ?? "") : "";
            if (!data.TryGetProperty("record", out var rec)) return;

            var latestSession = NativePrefs.LoadSession() ?? session;

            switch (table)
            {
                case "messages":
                {
                    var senderId = rec.TryGetProperty("sender_id", out var sid) ? (sid.GetString() ?? "") : "";
                    var convId = rec.TryGetProperty("conversation_id", out var cid) ? (cid.GetString() ?? "") : "";
                    var msgId = rec.TryGetProperty("id", out var mid) ? (mid.GetString() ?? "") : "";
                    var createdAt = rec.TryGetProperty("created_at", out var cat) ? (cat.GetString() ?? "") : "";
                    if (!string.IsNullOrWhiteSpace(createdAt)) NativePrefs.SaveLastSeenIso(createdAt);
                    if (string.IsNullOrWhiteSpace(senderId) || senderId == latestSession.UserId || string.IsNullOrWhiteSpace(convId)) return;

                    latestSession.Chats.TryGetValue(convId, out var meta);
                    if (meta?.Muted == true) return;
                    var body = rec.TryGetProperty("body", out var bd) ? (bd.GetString() ?? "") : "";
                    if (string.IsNullOrWhiteSpace(body))
                    {
                        body = rec.TryGetProperty("attachment_id", out var att) && att.ValueKind != JsonValueKind.Null
                            ? "Sent an attachment"
                            : "New message";
                    }
                    NotificationReceived?.Invoke(convId, meta?.Name ?? "Whisper", body, meta?.Avatar ?? "", $"whisper-msg-{convId}", msgId);
                    break;
                }
                case "contact_requests":
                {
                    var receiverId = rec.TryGetProperty("receiver_id", out var rid) ? (rid.GetString() ?? "") : "";
                    var status = rec.TryGetProperty("status", out var st) ? (st.GetString() ?? "") : "";
                    var reqId = rec.TryGetProperty("id", out var idEl) ? (idEl.GetString() ?? "") : "";
                    if (receiverId == latestSession.UserId && status == "pending")
                    {
                        NotificationReceived?.Invoke("", "New friend request", "Someone would like to connect on Whisper.", "", "whisper-request", $"req-{reqId}");
                    }
                    break;
                }
                case "call_invites":
                {
                    var callerId = rec.TryGetProperty("caller_id", out var cidEl) ? (cidEl.GetString() ?? "") : "";
                    if (callerId == latestSession.UserId) return;
                    var convId = rec.TryGetProperty("conversation_id", out var convEl) ? (convEl.GetString() ?? "") : "";
                    var callId = rec.TryGetProperty("id", out var idEl) ? (idEl.GetString() ?? "") : "";
                    latestSession.Chats.TryGetValue(convId, out var meta);
                    var peerName = meta?.Name ?? "Your contact";
                    NotificationReceived?.Invoke(convId, "Incoming call", $"{peerName} is trying to reach you.", meta?.Avatar ?? "", string.IsNullOrWhiteSpace(convId) ? "whisper-call" : $"whisper-call-{convId}", $"call-{callId}");
                    break;
                }
            }
        }
        catch
        {
        }
    }

    private async Task CatchUpMissedMessagesAsync(StoredSession session, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(session.LastSeenIso))
        {
            NativePrefs.SaveLastSeenIso(DateTimeOffset.UtcNow.ToString("O"));
            return;
        }

        try
        {
            var url = $"{session.SupabaseUrl}/rest/v1/messages?select=id,conversation_id,sender_id,body,attachment_id,created_at&created_at=gt.{Uri.EscapeDataString(session.LastSeenIso)}&sender_id=neq.{Uri.EscapeDataString(session.UserId)}&order=created_at.asc&limit=20";
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.TryAddWithoutValidation("apikey", session.AnonKey);
            req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {session.AccessToken}");

            using var resp = await _http.SendAsync(req, ct);
            if (!resp.IsSuccessStatusCode) return;
            using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(ct));
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return;

            var latestSession = NativePrefs.LoadSession() ?? session;
            foreach (var row in doc.RootElement.EnumerateArray())
            {
                var convId = row.TryGetProperty("conversation_id", out var cid) ? (cid.GetString() ?? "") : "";
                var msgId = row.TryGetProperty("id", out var mid) ? (mid.GetString() ?? "") : "";
                var createdAt = row.TryGetProperty("created_at", out var cat) ? (cat.GetString() ?? "") : "";
                if (!string.IsNullOrWhiteSpace(createdAt)) NativePrefs.SaveLastSeenIso(createdAt);
                if (string.IsNullOrWhiteSpace(convId)) continue;

                latestSession.Chats.TryGetValue(convId, out var meta);
                if (meta?.Muted == true) continue;
                var body = row.TryGetProperty("body", out var bd) ? (bd.GetString() ?? "") : "";
                if (string.IsNullOrWhiteSpace(body))
                {
                    body = row.TryGetProperty("attachment_id", out var att) && att.ValueKind != JsonValueKind.Null
                        ? "Sent an attachment"
                        : "New message";
                }
                NotificationReceived?.Invoke(convId, meta?.Name ?? "Whisper", body, meta?.Avatar ?? "", $"whisper-msg-{convId}", msgId);
            }
        }
        catch
        {
        }
    }

    public async Task SendQuickReplyAsync(string conversationId, string body)
    {
        try
        {
            var session = await NativePrefs.RefreshAccessTokenIfNeededAsync(_http);
            if (session == null || string.IsNullOrWhiteSpace(conversationId) || string.IsNullOrWhiteSpace(body)) return;

            using var req = new HttpRequestMessage(HttpMethod.Post, $"{session.SupabaseUrl}/rest/v1/messages");
            req.Headers.TryAddWithoutValidation("apikey", session.AnonKey);
            req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {session.AccessToken}");
            req.Headers.TryAddWithoutValidation("Prefer", "return=minimal");
            req.Content = new StringContent(
                JsonSerializer.Serialize(new { conversation_id = conversationId, sender_id = session.UserId, body }),
                Encoding.UTF8,
                "application/json");
            using var _ = await _http.SendAsync(req);

            await MarkConversationReadAsync(conversationId);

            using var pushReq = new HttpRequestMessage(HttpMethod.Post, $"{session.SupabaseUrl}/functions/v1/push");
            pushReq.Headers.TryAddWithoutValidation("apikey", session.AnonKey);
            pushReq.Headers.TryAddWithoutValidation("Authorization", $"Bearer {session.AccessToken}");
            pushReq.Content = new StringContent(
                JsonSerializer.Serialize(new { conversationId, title = "Whisper", body, tag = $"whisper-msg-{conversationId}" }),
                Encoding.UTF8,
                "application/json");
            try { using var __ = await _http.SendAsync(pushReq); } catch { }
        }
        catch
        {
        }
    }

    public async Task MarkConversationReadAsync(string conversationId)
    {
        try
        {
            var session = await NativePrefs.RefreshAccessTokenIfNeededAsync(_http);
            if (session == null || string.IsNullOrWhiteSpace(conversationId)) return;

            using var req = new HttpRequestMessage(
                HttpMethod.Patch,
                $"{session.SupabaseUrl}/rest/v1/conversation_members?conversation_id=eq.{conversationId}&user_id=eq.{session.UserId}");
            req.Headers.TryAddWithoutValidation("apikey", session.AnonKey);
            req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {session.AccessToken}");
            req.Content = new StringContent(
                JsonSerializer.Serialize(new { last_read_at = DateTimeOffset.UtcNow.ToString("O") }),
                Encoding.UTF8,
                "application/json");
            using var _ = await _http.SendAsync(req);
        }
        catch
        {
        }
    }

    private static Task SendJsonAsync(ClientWebSocket ws, object payload, CancellationToken ct)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload));
        return ws.SendAsync(bytes, WebSocketMessageType.Text, true, ct);
    }
}
