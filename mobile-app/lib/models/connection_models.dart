import 'dart:convert';

enum ConnectionType {
  local, // Local server (direct IP connection)
  relay, // Relay server (session ID based)
  tunnel, // Cloudflare Tunnel (wss://….trycloudflare.com)
}

class ConnectionHistoryItem {
  final ConnectionType type;
  final String? ip; // local / tunnel host
  final int? port; // local / tunnel port
  final String? sessionId; // relay mode
  final DateTime timestamp;

  ConnectionHistoryItem({
    required this.type,
    this.ip,
    this.port,
    this.sessionId,
    required this.timestamp,
  });

  // JSON serialization
  Map<String, dynamic> toJson() => {
        'type': type.index,
        'ip': ip,
        'port': port,
        'sessionId': sessionId,
        'timestamp': timestamp.toIso8601String(),
      };

  // JSON deserialization
  factory ConnectionHistoryItem.fromJson(Map<String, dynamic> json) {
    final typeIndex = json['type'] as int;
    final type = (typeIndex >= 0 && typeIndex < ConnectionType.values.length)
        ? ConnectionType.values[typeIndex]
        : ConnectionType.relay;
    return ConnectionHistoryItem(
      type: type,
      ip: json['ip'] as String?,
      port: json['port'] is int
          ? json['port'] as int
          : int.tryParse('${json['port'] ?? ''}'),
      sessionId: json['sessionId'] as String?,
      timestamp: DateTime.parse(json['timestamp'] as String),
    );
  }

  // Checks whether two items represent the same connection (type + address/sessionId)
  bool isSameConnection(ConnectionHistoryItem other) {
    if (type != other.type) return false;
    if (type == ConnectionType.local || type == ConnectionType.tunnel) {
      return ip == other.ip && port == other.port;
    }
    return sessionId == other.sessionId;
  }

  // Display string
  String get displayText {
    if (type == ConnectionType.local || type == ConnectionType.tunnel) {
      final localIp = ip ?? 'Unknown host';
      return port != null ? '$localIp:$port' : localIp;
    }
    return sessionId ?? 'Unknown Session';
  }

  // Relative time string
  String get relativeTime {
    final now = DateTime.now();
    final diff = now.difference(timestamp);

    if (diff.inMinutes < 1) {
      return 'Just now';
    } else if (diff.inMinutes < 60) {
      return '${diff.inMinutes}m ago';
    } else if (diff.inHours < 24) {
      return '${diff.inHours}h ago';
    } else if (diff.inDays < 7) {
      return '${diff.inDays}d ago';
    } else {
      return '${timestamp.month}/${timestamp.day}';
    }
  }
}

List<ConnectionHistoryItem> parseConnectionHistory(String historyJson) {
  try {
    final historyList = jsonDecode(historyJson) as List;
    return historyList
        .map((item) =>
            ConnectionHistoryItem.fromJson(item as Map<String, dynamic>))
        .toList();
  } catch (_) {
    return [];
  }
}
