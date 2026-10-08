import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import '../models/connection_models.dart';

/// Result of sending one command; relay sends also carry the relay's policy decision.
class SendResult {
  final String? error;
  final String policyDecision;
  const SendResult({this.error, this.policyDecision = ''});
  bool get ok => error == null && policyDecision != 'deny' && policyDecision != 'approval_required';

  /// Why the command did not reach Cursor, or null if it did. A held or denied relay command is a failure.
  String? get failure => error ?? switch (policyDecision) {
        'approval_required' => 'The relay held this command for approval, so it was not sent to Cursor',
        'deny' => 'The relay blocked this command',
        _ => null,
      };
}

/// Loopback, LAN, link-local, CGNAT/Tailscale, mDNS and single-label hosts: where plain ws:// is expected.
bool isPrivateHost(String host) {
  final h = host.trim().toLowerCase().replaceAll(RegExp(r'^\[|\]$'), '');
  if (h.isEmpty) return false;
  if (h == 'localhost' || h.endsWith('.local') || h.endsWith('.localhost')) return true;
  final v4 = RegExp(r'^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$').firstMatch(h);
  if (v4 != null) {
    final o = [for (var i = 1; i <= 4; i++) int.parse(v4.group(i)!)];
    if (o.any((n) => n > 255)) return false;
    return o[0] == 10 || o[0] == 127 ||
        (o[0] == 172 && o[1] >= 16 && o[1] <= 31) ||
        (o[0] == 192 && o[1] == 168) ||
        (o[0] == 169 && o[1] == 254) ||
        (o[0] == 100 && o[1] >= 64 && o[1] <= 127);
  }
  if (h.contains(':')) return h == '::1' || RegExp(r'^f[cd]').hasMatch(h) || RegExp(r'^fe[89ab]').hasMatch(h);
  return !h.contains('.');
}

/// Asks the user for a pairing code; null cancels.
typedef PairingPrompt = Future<String?> Function({required bool relay});

/// Transport to the Cursor extension over Local WebSocket, Cloudflare Tunnel or the Relay.
/// Every inbound message, whatever the transport, reaches [onInbound] as one decoded map.
class CursorConnection extends ChangeNotifier {
  CursorConnection({required this.relayUrl});

  final String relayUrl;

  /// Relay polling cadence: fast while the user or the agent is active, slower otherwise,
  /// and none while the app is hidden (each poll costs the relay several Redis commands).
  static const activePoll = Duration(seconds: 2);
  static const idlePoll = Duration(seconds: 10);
  static const activeWindow = Duration(minutes: 2);
  static const maxReconnectAttempts = 5;

  /// Local/Tunnel sockets can die without a close frame (Wi-Fi drop, Mac asleep); a ping that
  /// gets no frame back within one interval counts as a dead connection.
  Duration heartbeatInterval = const Duration(seconds: 20);

  ConnectionType type = ConnectionType.relay;
  bool connected = false;
  bool connecting = false;
  bool reconnecting = false;
  int reconnectAttempts = 0;
  String? lastError;
  String? sessionId;
  String deviceId = '';

  void Function(Map<String, dynamic> message)? onInbound;
  void Function(String text)? onSystem;
  VoidCallback? onConnected;
  /// Automatic reconnection stopped (attempts used up, or the credential was refused).
  VoidCallback? onGaveUp;
  PairingPrompt? askPairingCode;

  /// True while a reply is expected, so polling stays fast.
  bool Function()? isBusy;

  WebSocketChannel? _socket;
  String? _localUrl;
  bool _localIsTunnel = false;
  String? _localLabel;
  String? _relayTarget;
  final Map<String, String> _localCredentials = {};
  final Map<String, String> _relayCredentials = {};
  final Map<String, String> _relayDeviceIds = {};

  Timer? _pollTimer;
  bool _polling = false;
  bool _visible = true;
  DateTime _lastActivity = DateTime.now();
  Timer? _reconnectTimer;
  Timer? _heartbeat;
  DateTime _lastInbound = DateTime.now();

  bool get isLocal => type == ConnectionType.local || type == ConnectionType.tunnel;

  Map<String, String> relayHeaders([String? session]) => {
        'Content-Type': 'application/json',
        if (_relayCredentials[session ?? sessionId] != null)
          'Authorization': 'Bearer ${_relayCredentials[session ?? sessionId]}',
      };

  void _system(String text) => onSystem?.call(text);

  void _set(void Function() update) {
    update();
    notifyListeners();
  }

  // ---- Activity / visibility ------------------------------------------------

  void markActive() {
    final wasIdle = DateTime.now().difference(_lastActivity) >= activeWindow;
    _lastActivity = DateTime.now();
    if (wasIdle && _pollTimer != null && !_polling) _schedulePoll(Duration.zero);
  }

  void setVisible(bool visible) {
    if (visible == _visible) return;
    _visible = visible;
    if (!visible) {
      _pollTimer?.cancel();
      _pollTimer = null;
    } else if (connected && type == ConnectionType.relay) {
      _lastActivity = DateTime.now();
      _schedulePoll(Duration.zero);
    }
  }

  Duration get pollDelay {
    final active = (isBusy?.call() ?? false) ||
        DateTime.now().difference(_lastActivity) < activeWindow;
    return active ? activePoll : idlePoll;
  }

  // ---- Local / Tunnel ---------------------------------------------------------

  Future<void> connectLocal(String wsUrl, {required bool tunnel, required String label}) async {
    if (connecting) return;
    try {
      await _socket?.sink.close();
    } catch (_) {}
    _socket = null;
    _stopHeartbeat();
    _stopPolling();
    stopReconnect();
    type = tunnel ? ConnectionType.tunnel : ConnectionType.local;
    _localUrl = wsUrl;
    _localIsTunnel = tunnel;
    _localLabel = label;
    _set(() {
      connecting = true;
      connected = false;
      lastError = null;
    });
    _system(tunnel ? 'Connecting via Cloudflare Tunnel ($label)…' : 'Connecting to Cursor Remote server at $label…');

    var handshakeComplete = false;
    var authenticationStarted = false;
    Timer? timeout;

    void fail(String userMessage, {String? technical, bool retry = true}) {
      if (handshakeComplete) return;
      handshakeComplete = true;
      timeout?.cancel();
      try {
        _socket?.sink.close();
      } catch (_) {}
      _socket = null;
      _set(() {
        connecting = false;
        connected = false;
        lastError = technical ?? userMessage;
      });
      _system('❌ $userMessage');
      if (retry) {
        scheduleReconnect();
      } else {
        onGaveUp?.call();
      }
    }

    void lost(WebSocketChannel socket, String message) {
      if (_socket != socket) return;
      _socket = null;
      _stopHeartbeat();
      try {
        socket.sink.close();
      } catch (_) {}
      _set(() {
        connected = false;
        connecting = false;
      });
      _system(message);
      scheduleReconnect();
    }

    void succeed() {
      if (handshakeComplete) return;
      handshakeComplete = true;
      timeout?.cancel();
      _set(() {
        connecting = false;
        connected = true;
        reconnecting = false;
        reconnectAttempts = 0;
        lastError = null;
      });
      stopReconnect();
      final socket = _socket;
      if (socket != null) _startHeartbeat(socket, () => lost(socket, 'Connection lost (no reply from Cursor).'));
      _system(tunnel ? '✅ Connected via Cloudflare Tunnel ($label)' : '✅ Connected to Cursor Remote server at $label');
      onConnected?.call();
    }

    try {
      final socket = WebSocketChannel.connect(Uri.parse(wsUrl));
      _socket = socket;
      _lastInbound = DateTime.now();
      timeout = Timer(const Duration(seconds: 120), () {
        fail(
          tunnel
              ? 'Tunnel connection timed out. Confirm the extension tunnel is running and paste the latest wss:// URL.'
              : 'Unable to connect to the Cursor Remote server. Check that Cursor is open with the extension running, and that your phone and Mac are on the same Wi-Fi network.',
          technical: 'Connection or pairing timed out after 120s ($wsUrl).',
        );
      });
      socket.stream.listen(
        (message) {
          if (_socket != socket) return;
          _lastInbound = DateTime.now();
          final raw = message.toString();
          if (!handshakeComplete) {
            try {
              final frame = jsonDecode(raw);
              if (frame is Map && frame['type'] == 'auth_required') {
                if (authenticationStarted) return;
                authenticationStarted = true;
              }
            } catch (_) {
              fail('Invalid authentication response', retry: false);
              return;
            }
            _authenticateLocalFrame(raw, wsUrl, socket, succeed, () {
              fail('Pairing failed. Use Cursor Remote: Pair Client in Cursor.', retry: false);
            });
            return;
          }
          _deliver(raw);
        },
        onError: (Object error) {
          if (_socket != socket) return;
          if (handshakeComplete) {
            lost(socket, 'Connection lost.');
            return;
          }
          fail(
            tunnel
                ? 'Tunnel unreachable. This network may block Cloudflare edge. Use Local on same Wi‑Fi — port may be 8767 if 8766 was busy.'
                : 'Unable to connect to the local Cursor Remote server. Make sure the Cursor extension is running and listening on that port.',
            technical: error.toString(),
          );
        },
        onDone: () {
          if (_socket != socket) return;
          if (socket.closeCode == 4001) _localCredentials.remove(wsUrl);
          if (!handshakeComplete) {
            fail(
              socket.closeCode == 4001
                  ? 'Pairing code rejected or expired. Run Cursor Remote: Pair Client again and paste the new code.'
                  : tunnel
                      ? 'Tunnel failed. Cloudflare edge is often blocked here — use Local (same Wi‑Fi). Check Cursor log for the real port (may be 8767, not 8766).'
                      : 'Unable to connect to the local Cursor Remote server. The connection closed before the handshake completed.',
              technical: socket.closeCode == 4001
                  ? 'Authentication failed (4001): ${socket.closeReason ?? ''}'
                  : 'WebSocket closed before handshake ($wsUrl)',
              retry: socket.closeCode != 4001,
            );
            return;
          }
          lost(socket, 'Connection closed.');
        },
        cancelOnError: true,
      );
    } catch (e) {
      fail(
        tunnel
            ? 'Unable to open the tunnel WebSocket. Check the wss:// URL.'
            : 'Unable to connect to the local Cursor Remote server. Check the address and that the extension is running.',
        technical: e.toString(),
        retry: false,
      );
    }
  }

  void _startHeartbeat(WebSocketChannel socket, VoidCallback onDead) {
    _stopHeartbeat();
    DateTime? pingedAt;
    _heartbeat = Timer.periodic(heartbeatInterval, (_) {
      if (_socket != socket) {
        _stopHeartbeat();
        return;
      }
      final sent = pingedAt;
      if (sent != null && _lastInbound.isBefore(sent)) {
        onDead();
        return;
      }
      pingedAt = DateTime.now();
      try {
        socket.sink.add(jsonEncode({'type': 'ping'}));
      } catch (_) {
        onDead();
      }
    });
  }

  void _stopHeartbeat() {
    _heartbeat?.cancel();
    _heartbeat = null;
  }

  Future<void> _authenticateLocalFrame(String raw, String endpoint, WebSocketChannel socket,
      VoidCallback onAuthenticated, VoidCallback onFailure) async {
    try {
      final frame = jsonDecode(raw);
      if (frame is! Map || frame['protocolVersion'] != 2) {
        onFailure();
        return;
      }
      if (frame['type'] == 'authenticated' && frame['scope'] == 'control') {
        final token = frame['token'];
        if (token is String) _localCredentials[endpoint] = token;
        onAuthenticated();
        return;
      }
      if (frame['type'] != 'auth_required') {
        onFailure();
        return;
      }
      final token = _localCredentials[endpoint];
      if (token != null) {
        socket.sink.add(jsonEncode({'type': 'authenticate', 'protocolVersion': 2, 'token': token}));
        return;
      }
      final secret = (await askPairingCode?.call(relay: false))?.trim() ?? '';
      if (socket != _socket) return;
      if (secret.isEmpty) {
        onFailure();
        return;
      }
      socket.sink.add(jsonEncode({'type': 'pair', 'protocolVersion': 2, 'secret': secret}));
    } catch (_) {
      _localCredentials.remove(endpoint);
      onFailure();
    }
  }

  // ---- Relay ------------------------------------------------------------------

  Future<void> connectRelay(String rawSessionId, [String? pairingCode]) async {
    final session = rawSessionId.trim().toUpperCase();
    if (session.isEmpty) return;
    type = ConnectionType.relay;
    _relayTarget = session;
    deviceId = _relayDeviceIds[session] ?? deviceId;
    if (deviceId.isEmpty) deviceId = 'mobile-${DateTime.now().millisecondsSinceEpoch}';
    _set(() {
      connecting = true;
      lastError = null;
    });
    _system(pairingCode != null
        ? 'Connecting to session $session with a pairing code...'
        : 'Connecting to session $session...');

    try {
      final response = await http
          .post(
            Uri.parse('$relayUrl/api/connect'),
            headers: relayHeaders(session),
            body: jsonEncode({
              'sessionId': session,
              'deviceId': deviceId,
              'deviceType': 'mobile',
              if (pairingCode != null && pairingCode.isNotEmpty) 'pairingCode': pairingCode,
            }),
          )
          .timeout(const Duration(seconds: 15));
      final body = response.body.isNotEmpty ? jsonDecode(response.body) as Map<String, dynamic>? : null;
      final data = body ?? <String, dynamic>{};
      final errorCode = data['errorCode']?.toString();
      final errorMessage = data['error']?.toString() ?? '';

      if (response.statusCode == 200 && data['success'] == true && data['protocolVersion'] == 2) {
        final assigned = data['data']?['deviceId'];
        if (assigned is String) {
          deviceId = assigned;
          _relayDeviceIds[session] = assigned;
        }
        final issued = data['data']?['token'];
        if (issued is String && issued.length == 43) _relayCredentials[session] = issued;
        if (_relayCredentials[session] == null) throw StateError('Missing relay credential');
        _set(() {
          sessionId = session;
          connected = true;
          connecting = false;
          reconnecting = false;
          reconnectAttempts = 0;
          lastError = null;
        });
        stopReconnect();
        _system('✅ Connected to session $session');
        _lastActivity = DateTime.now();
        _schedulePoll(Duration.zero);
        onConnected?.call();
      } else if (errorCode == 'PAIRING_CODE_REQUIRED') {
        final code = await askPairingCode?.call(relay: true);
        if (code != null && code.isNotEmpty) {
          await connectRelay(session, code);
        } else {
          _set(() => connecting = false);
        }
      } else if ([401, 403].contains(response.statusCode)) {
        _relayCredentials.remove(session);
        onGaveUp?.call();
        _set(() {
          connected = false;
          connecting = false;
          lastError = 'Relay authentication failed ($errorCode). Check the session and obtain a new pairing code in Cursor.';
        });
      } else if (response.statusCode == 409 || response.statusCode == 429) {
        final error = response.statusCode == 409
            ? 'Your Mac is not connected to session $session yet. Keep Cursor open and awake; retrying…'
            : 'The relay is busy. Retrying shortly…';
        _set(() {
          connected = false;
          connecting = false;
          lastError = error;
        });
        _system('⏳ $error');
        scheduleReconnect(atLeast: response.statusCode == 429 ? const Duration(seconds: 30) : null);
      } else {
        final error = errorMessage.isNotEmpty
            ? errorMessage
            : 'Unable to connect to the relay server (HTTP ${response.statusCode}).';
        _set(() {
          connecting = false;
          lastError = error;
        });
        _system('❌ Connection failed: $error');
        if (!error.toLowerCase().contains('session not found')) {
          scheduleReconnect();
        } else {
          onGaveUp?.call();
        }
      }
    } catch (e) {
      _set(() {
        connecting = false;
        lastError = e.toString();
      });
      _system(e is TimeoutException
          ? '❌ The relay server did not respond in time. Check your internet connection and try again.'
          : '❌ Unable to reach the relay server. Check your internet connection and try again.');
      scheduleReconnect();
    }
  }

  void _schedulePoll(Duration delay) {
    _pollTimer?.cancel();
    if (!_visible || !connected || type != ConnectionType.relay) {
      _pollTimer = null;
      return;
    }
    _pollTimer = Timer(delay, _poll);
  }

  Future<void> _poll() async {
    final session = sessionId;
    if (!connected || session == null || _polling) return;
    _polling = true;
    try {
      final response = await http
          .get(
            Uri.parse('$relayUrl/api/poll?sessionId=$session&deviceType=mobile&deviceId=$deviceId'),
            headers: relayHeaders(),
          )
          .timeout(const Duration(seconds: 15));
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        final payload = data['success'] == true ? data['data'] : null;
        final messages = payload is Map ? payload['messages'] : null;
        if (messages is List && messages.isNotEmpty) {
          _lastActivity = DateTime.now();
          for (final msg in messages) {
            if (msg is Map) _deliverRelay(Map<String, dynamic>.from(msg));
          }
        }
        _polling = false;
        _schedulePoll(pollDelay);
        return;
      }
      _stopPolling();
      if ([401, 403].contains(response.statusCode)) {
        _relayCredentials.remove(session);
        onGaveUp?.call();
      }
      _set(() {
        connected = false;
        lastError = 'Relay polling failed (HTTP ${response.statusCode}). Reconnect to continue.';
      });
      if (![401, 403].contains(response.statusCode)) scheduleReconnect();
    } catch (_) {
      _stopPolling();
      _set(() {
        connected = false;
        lastError = 'Relay connection lost. Reconnect to continue.';
      });
      scheduleReconnect();
    } finally {
      _polling = false;
    }
  }

  void _stopPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  /// Authenticated GET/POST to a relay endpoint (approvals, events); null when not on the relay.
  Future<http.Response?> relayGet(String path, Map<String, String> query) {
    if (type != ConnectionType.relay || sessionId == null) return Future.value(null);
    return http.get(Uri.parse('$relayUrl$path').replace(queryParameters: {'sessionId': sessionId!, ...query}),
        headers: relayHeaders());
  }

  Future<http.Response?> relayPost(String path, Map<String, dynamic> body) {
    if (type != ConnectionType.relay || sessionId == null) return Future.value(null);
    return http.post(Uri.parse('$relayUrl$path'),
        headers: relayHeaders(), body: jsonEncode({'sessionId': sessionId, ...body}));
  }

  // ---- Inbound ------------------------------------------------------------------

  void _deliver(String raw) {
    Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } catch (_) {
      _system('Received: $raw');
      return;
    }
    if (decoded is! Map) return;
    // Heartbeat replies: `pong`, or the id-less rejection an older extension sends for a ping.
    if (decoded['type'] == 'pong') return;
    if (decoded['type'] == 'command_result' && decoded['id'] == null && decoded['status'] == 'invalid_or_expired_command') return;
    onInbound?.call(Map<String, dynamic>.from(decoded));
  }

  /// Relay queue entries wrap the extension payload in `data` (sometimes as a JSON string).
  void _deliverRelay(Map<String, dynamic> msg) {
    var payload = msg['data'] ?? msg;
    if (payload is String) {
      try {
        payload = jsonDecode(payload);
      } catch (_) {
        return;
      }
    }
    if (payload is Map) {
      final map = Map<String, dynamic>.from(payload);
      map['type'] ??= msg['type'];
      onInbound?.call(map);
    }
  }

  // ---- Outbound -----------------------------------------------------------------

  Future<SendResult> send(Map<String, dynamic> command) async {
    if (!connected) return const SendResult(error: 'Not connected');
    markActive();
    if (isLocal) {
      final socket = _socket;
      if (socket == null) return const SendResult(error: 'Local WebSocket not connected');
      socket.sink.add(jsonEncode(command));
      return const SendResult();
    }
    final session = sessionId;
    if (session == null) return const SendResult(error: 'Session ID is required for relay connection');
    try {
      final response = await http
          .post(
            Uri.parse('$relayUrl/api/send'),
            headers: relayHeaders(),
            body: jsonEncode({
              'sessionId': session,
              'deviceId': deviceId,
              'deviceType': 'mobile',
              'type': command['type'],
              'data': command,
            }),
          )
          .timeout(const Duration(seconds: 15));
      Map<String, dynamic>? body;
      if (response.body.isNotEmpty) {
        try {
          body = jsonDecode(response.body) as Map<String, dynamic>?;
        } catch (_) {}
      }
      final meta = body?['data'] is Map ? Map<String, dynamic>.from(body!['data']) : const <String, dynamic>{};
      final decision = meta['policyDecision']?.toString() ?? '';
      final success = response.statusCode == 200 && body?['success'] == true;
      return SendResult(
        error: success || decision == 'approval_required'
            ? null
            : (body?['error']?.toString() ?? 'HTTP ${response.statusCode}'),
        policyDecision: decision,
      );
    } catch (e) {
      return SendResult(error: e is TimeoutException ? 'The relay did not respond in time' : 'Send error: $e');
    }
  }

  // ---- Reconnect / disconnect -----------------------------------------------------

  void scheduleReconnect({Duration? atLeast}) {
    if (reconnecting || connected) return;
    if (reconnectAttempts >= maxReconnectAttempts) {
      onGaveUp?.call();
      _set(() => reconnecting = false);
      _system('❌ Reconnection failed after $maxReconnectAttempts attempts. Please reconnect manually.');
      return;
    }
    reconnectAttempts++;
    var delay = Duration(seconds: 2 * (1 << (reconnectAttempts - 1)));
    if (atLeast != null && delay < atLeast) delay = atLeast;
    _set(() => reconnecting = true);
    _system('🔄 Reconnecting in ${delay.inSeconds}s... (attempt $reconnectAttempts/$maxReconnectAttempts)');
    _reconnectTimer = Timer(delay, () {
      reconnecting = false;
      if (connected) return;
      if (isLocal && _localUrl != null) {
        connectLocal(_localUrl!, tunnel: _localIsTunnel, label: _localLabel ?? _localUrl!);
      } else if (!isLocal && _relayTarget != null) {
        connectRelay(_relayTarget!);
      } else {
        notifyListeners();
      }
    });
  }

  void stopReconnect() {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    reconnecting = false;
  }

  void resetReconnectAttempts() => reconnectAttempts = 0;

  /// Closes the transport and, on the relay, revokes this device's credential.
  Future<String?> disconnect() async {
    final relaySession = type == ConnectionType.relay ? sessionId : null;
    final headers = relayHeaders();
    _stopPolling();
    _stopHeartbeat();
    stopReconnect();
    try {
      await _socket?.sink.close();
    } catch (_) {}
    _socket = null;
    _set(() {
      connected = false;
      connecting = false;
      sessionId = null;
      reconnectAttempts = 0;
    });
    _system('Disconnected');
    if (relaySession == null || !_relayCredentials.containsKey(relaySession)) return null;
    try {
      final response = await http
          .post(Uri.parse('$relayUrl/api/disconnect'),
              headers: headers, body: jsonEncode({'sessionId': relaySession}))
          .timeout(const Duration(seconds: 15));
      if (response.statusCode != 200) throw StateError('Disconnect failed');
      _relayCredentials.remove(relaySession);
      return null;
    } catch (_) {
      return 'Disconnected locally; server revocation was not confirmed. Revoke the relay session in Cursor if needed.';
    }
  }

  @override
  void dispose() {
    _stopPolling();
    _stopHeartbeat();
    stopReconnect();
    _socket?.sink.close();
    super.dispose();
  }
}
