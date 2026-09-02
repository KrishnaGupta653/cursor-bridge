/// Models for Existing Cursor Agent (CDP) control center.
library;

class CdpSessionInfo {
  final String id;
  final String title;
  final String state;
  final bool connected;
  final String? targetId;
  final String? workspace;
  final String? model;
  final String? latestMessage;
  final String? latestActivity;
  final String? lastActivity;
  final bool hasPendingPermission;
  final int unreadCount;

  const CdpSessionInfo({
    required this.id,
    required this.title,
    required this.state,
    required this.connected,
    this.targetId,
    this.workspace,
    this.model,
    this.latestMessage,
    this.latestActivity,
    this.lastActivity,
    this.hasPendingPermission = false,
    this.unreadCount = 0,
  });

  factory CdpSessionInfo.fromJson(Map<String, dynamic> json) {
    return CdpSessionInfo(
      id: json['id']?.toString() ?? '',
      title: json['title']?.toString() ?? 'Cursor',
      state: json['state']?.toString() ?? 'UNKNOWN',
      connected: json['connected'] == true,
      targetId: json['targetId']?.toString(),
      workspace: json['workspace']?.toString(),
      model: json['model']?.toString(),
      latestMessage: json['latestMessage']?.toString(),
      latestActivity: json['latestActivity']?.toString(),
      lastActivity: json['lastActivity']?.toString(),
      hasPendingPermission: json['hasPendingPermission'] == true,
      unreadCount: int.tryParse(json['unreadCount']?.toString() ?? '') ?? 0,
    );
  }

  CdpSessionInfo copyWith({
    String? state,
    bool? connected,
    String? workspace,
    String? model,
    String? latestMessage,
    String? latestActivity,
    String? lastActivity,
    bool? hasPendingPermission,
    int? unreadCount,
    String? title,
  }) {
    return CdpSessionInfo(
      id: id,
      title: title ?? this.title,
      state: state ?? this.state,
      connected: connected ?? this.connected,
      targetId: targetId,
      workspace: workspace ?? this.workspace,
      model: model ?? this.model,
      latestMessage: latestMessage ?? this.latestMessage,
      latestActivity: latestActivity ?? this.latestActivity,
      lastActivity: lastActivity ?? this.lastActivity,
      hasPendingPermission:
          hasPendingPermission ?? this.hasPendingPermission,
      unreadCount: unreadCount ?? this.unreadCount,
    );
  }

  String get displayName {
    if (workspace != null && workspace!.isNotEmpty) return workspace!;
    return title;
  }

  String get stateLabel {
    switch (state.toUpperCase()) {
      case 'RUNNING':
        return 'Agent Working';
      case 'WAITING_FOR_PERMISSION':
        return 'Waiting for approval';
      case 'WAITING_FOR_INPUT':
        return 'Waiting for input';
      case 'IDLE':
        return 'Idle';
      case 'COMPLETED':
        return 'Completed';
      case 'ERROR':
        return 'Error';
      default:
        return state;
    }
  }
}

class CdpHistoryItem {
  final String id;
  final String title;
  final String group;
  final String kind;
  final String? relativeTime;

  const CdpHistoryItem({
    required this.id,
    required this.title,
    required this.group,
    required this.kind,
    this.relativeTime,
  });

  factory CdpHistoryItem.fromJson(Map<String, dynamic> json) {
    return CdpHistoryItem(
      id: json['id']?.toString() ?? '',
      title: json['title']?.toString() ?? '',
      group: json['group']?.toString() ?? 'Repository',
      kind: json['kind']?.toString() ?? 'history',
      relativeTime: json['relativeTime']?.toString(),
    );
  }

  bool get isPinned => kind == 'pinned' || group.toLowerCase() == 'pinned';
}

class CdpAgentMessage {
  final String id;
  final String role;
  final String text;
  final String? timestamp;
  final String? status;

  const CdpAgentMessage({
    required this.id,
    required this.role,
    required this.text,
    this.timestamp,
    this.status,
  });

  factory CdpAgentMessage.fromJson(Map<String, dynamic> json) {
    return CdpAgentMessage(
      id: json['id']?.toString() ??
          DateTime.now().millisecondsSinceEpoch.toString(),
      role: json['role']?.toString() ?? 'assistant',
      text: json['text']?.toString() ?? '',
      timestamp: json['timestamp']?.toString(),
      status: json['status']?.toString(),
    );
  }

  CdpAgentMessage copyWith({
    String? text,
    String? status,
    String? role,
    String? timestamp,
  }) =>
      CdpAgentMessage(
        id: id,
        role: role ?? this.role,
        text: text ?? this.text,
        timestamp: timestamp ?? this.timestamp,
        status: status ?? this.status,
      );
}

class CdpPermissionRequest {
  final String id;
  final String title;
  final String detail;

  const CdpPermissionRequest({
    required this.id,
    required this.title,
    required this.detail,
  });

  factory CdpPermissionRequest.fromJson(Map<String, dynamic> json) {
    return CdpPermissionRequest(
      id: json['id']?.toString() ?? '',
      title: json['title']?.toString() ?? 'Permission Required',
      detail: json['detail']?.toString() ??
          json['rawText']?.toString() ??
          'Agent is waiting for approval',
    );
  }
}

class CdpPlanStep {
  final String id;
  final String text;
  final String status;

  const CdpPlanStep({
    required this.id,
    required this.text,
    required this.status,
  });

  factory CdpPlanStep.fromJson(Map<String, dynamic> json) {
    return CdpPlanStep(
      id: json['id']?.toString() ?? '',
      text: json['text']?.toString() ?? '',
      status: json['status']?.toString() ?? 'unknown',
    );
  }
}

class CdpAgentPlan {
  final String title;
  final List<CdpPlanStep> steps;
  final bool available;
  final String support;

  const CdpAgentPlan({
    required this.title,
    required this.steps,
    required this.available,
    this.support = 'NOT_CURRENTLY_ACCESSIBLE',
  });

  factory CdpAgentPlan.fromJson(Map<String, dynamic>? json) {
    if (json == null) {
      return const CdpAgentPlan(title: '', steps: [], available: false);
    }
    final rawSteps = json['steps'];
    final steps = rawSteps is List
        ? rawSteps
            .whereType<Map>()
            .map((e) => CdpPlanStep.fromJson(Map<String, dynamic>.from(e)))
            .toList()
        : <CdpPlanStep>[];
    return CdpAgentPlan(
      title: json['title']?.toString() ?? '',
      steps: steps,
      available: json['available'] == true || steps.isNotEmpty,
      support: json['support']?.toString() ??
          (steps.isNotEmpty
              ? 'PARTIALLY_SUPPORTED'
              : 'NOT_CURRENTLY_ACCESSIBLE'),
    );
  }
}

class CdpFileChange {
  final String path;
  final String changeType;

  const CdpFileChange({required this.path, required this.changeType});

  factory CdpFileChange.fromJson(Map<String, dynamic> json) {
    return CdpFileChange(
      path: json['path']?.toString() ?? '',
      changeType: json['changeType']?.toString() ?? 'unknown',
    );
  }
}

class CdpFileChanges {
  final List<CdpFileChange> items;
  final bool available;
  final String support;
  final String? note;

  const CdpFileChanges({
    required this.items,
    required this.available,
    this.support = 'NOT_CURRENTLY_ACCESSIBLE',
    this.note,
  });

  factory CdpFileChanges.fromJson(Map<String, dynamic>? json) {
    if (json == null) {
      return const CdpFileChanges(items: [], available: false);
    }
    final raw = json['items'];
    final items = raw is List
        ? raw
            .whereType<Map>()
            .map((e) => CdpFileChange.fromJson(Map<String, dynamic>.from(e)))
            .toList()
        : <CdpFileChange>[];
    return CdpFileChanges(
      items: items,
      available: json['available'] == true || items.isNotEmpty,
      support: json['support']?.toString() ?? 'NOT_CURRENTLY_ACCESSIBLE',
      note: json['note']?.toString(),
    );
  }
}

class CdpActivityEvent {
  final String id;
  final String text;
  final String kind;
  final String timestamp;

  const CdpActivityEvent({
    required this.id,
    required this.text,
    required this.kind,
    required this.timestamp,
  });

  factory CdpActivityEvent.fromJson(Map<String, dynamic> json) {
    return CdpActivityEvent(
      id: json['id']?.toString() ?? '',
      text: json['text']?.toString() ?? '',
      kind: json['kind']?.toString() ?? 'info',
      timestamp: json['timestamp']?.toString() ??
          DateTime.now().toIso8601String(),
    );
  }
}

/// Per-session view state kept on the phone for independent control.
class CdpSessionViewState {
  CdpSessionInfo info;
  List<CdpAgentMessage> messages;
  CdpAgentPlan? plan;
  CdpPermissionRequest? pendingApproval;
  CdpFileChanges fileChanges;
  List<CdpActivityEvent> activity;
  List<String> extractionNotes;
  Map<String, String> capabilities;

  CdpSessionViewState({
    required this.info,
    this.messages = const [],
    this.plan,
    this.pendingApproval,
    this.fileChanges = const CdpFileChanges(items: [], available: false),
    this.activity = const [],
    this.extractionNotes = const [],
    this.capabilities = const {},
  });
}

class CdpStatusSummary {
  final int working;
  final int waiting;
  final int idle;
  final int error;

  const CdpStatusSummary({
    this.working = 0,
    this.waiting = 0,
    this.idle = 0,
    this.error = 0,
  });

  factory CdpStatusSummary.fromSessions(Iterable<CdpSessionInfo> sessions) {
    var working = 0, waiting = 0, idle = 0, error = 0;
    for (final s in sessions) {
      switch (s.state.toUpperCase()) {
        case 'RUNNING':
          working++;
          break;
        case 'WAITING_FOR_PERMISSION':
        case 'WAITING_FOR_INPUT':
          waiting++;
          break;
        case 'ERROR':
          error++;
          break;
        default:
          idle++;
      }
    }
    return CdpStatusSummary(
      working: working,
      waiting: waiting,
      idle: idle,
      error: error,
    );
  }

  factory CdpStatusSummary.fromJson(Map<String, dynamic>? json) {
    if (json == null) return const CdpStatusSummary();
    return CdpStatusSummary(
      working: (json['working'] as num?)?.toInt() ?? 0,
      waiting: (json['waiting'] as num?)?.toInt() ?? 0,
      idle: (json['idle'] as num?)?.toInt() ?? 0,
      error: (json['error'] as num?)?.toInt() ?? 0,
    );
  }
}

ColorForState colorHintForAgentState(String state) {
  switch (state.toUpperCase()) {
    case 'RUNNING':
      return ColorForState.green;
    case 'WAITING_FOR_PERMISSION':
    case 'WAITING_FOR_INPUT':
      return ColorForState.yellow;
    case 'ERROR':
      return ColorForState.red;
    case 'IDLE':
    case 'COMPLETED':
      return ColorForState.grey;
    default:
      return ColorForState.grey;
  }
}

enum ColorForState { green, yellow, red, grey }

String emojiForAgentState(String state) {
  switch (colorHintForAgentState(state)) {
    case ColorForState.green:
      return '🟢';
    case ColorForState.yellow:
      return '🟡';
    case ColorForState.red:
      return '🔴';
    case ColorForState.grey:
      return '⚪';
  }
}
