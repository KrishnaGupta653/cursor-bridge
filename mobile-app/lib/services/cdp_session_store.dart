import 'package:flutter/foundation.dart';
import '../models/cdp_models.dart';

/// Shared multi-session store for Existing Cursor Agent mode.
class CdpSessionStore extends ChangeNotifier {
  bool cdpConnected = false;
  String? cdpError;
  CdpStatusSummary summary = const CdpStatusSummary();
  final Map<String, CdpSessionViewState> sessions = {};
  List<CdpHistoryItem> history = [];
  bool historyAvailable = false;
  String historySupport = 'NOT_CURRENTLY_ACCESSIBLE';
  String? historyNote;
  String? historySourceSessionId;
  /// Session currently open in the detail pane — unread stays at 0.
  String? focusedSessionId;

  void setFocusedSession(String? id) {
    focusedSessionId = id;
    if (id != null) {
      final view = sessions[id];
      if (view != null && view.info.unreadCount != 0) {
        view.info = view.info.copyWith(unreadCount: 0);
        notifyListeners();
      }
    }
  }

  void applyInbound(Map<String, dynamic> data) {
    final type = data['type']?.toString() ?? '';
    switch (type) {
      case 'cdp_status':
        cdpConnected = data['connected'] == true;
        cdpError = data['error']?.toString();
        if (data['summary'] is Map) {
          summary = CdpStatusSummary.fromJson(
              Map<String, dynamic>.from(data['summary'] as Map));
        }
        notifyListeners();
        break;
      case 'sessions':
        final raw = data['sessions'];
        if (raw is List) {
          final seen = <String>{};
          for (final item in raw.whereType<Map>()) {
            final info =
                CdpSessionInfo.fromJson(Map<String, dynamic>.from(item));
            seen.add(info.id);
            final existing = sessions[info.id];
            if (existing == null) {
              sessions[info.id] = CdpSessionViewState(info: info);
            } else {
              existing.info = info.copyWith(
                unreadCount: existing.info.unreadCount,
                model: info.model ?? existing.info.model,
              );
            }
          }
          sessions.removeWhere((id, _) => !seen.contains(id));
          summary = CdpStatusSummary.fromSessions(
              sessions.values.map((e) => e.info));
          notifyListeners();
        }
        break;
      case 'agent_history':
        historyAvailable = data['available'] == true;
        historySupport =
            data['support']?.toString() ?? 'NOT_CURRENTLY_ACCESSIBLE';
        historyNote = data['note']?.toString();
        historySourceSessionId = data['sourceSessionId']?.toString() ??
            data['sessionId']?.toString();
        final rawHist = data['items'];
        if (rawHist is List) {
          history = rawHist
              .whereType<Map>()
              .map((e) =>
                  CdpHistoryItem.fromJson(Map<String, dynamic>.from(e)))
              .where((e) => e.title.isNotEmpty)
              .toList();
        } else {
          history = [];
        }
        notifyListeners();
        break;
      case 'agent_state':
        final id = data['sessionId']?.toString();
        if (id == null) return;
        final view = sessions.putIfAbsent(
          id,
          () => CdpSessionViewState(
            info: CdpSessionInfo(
              id: id,
              title: data['title']?.toString() ?? 'Cursor',
              state: data['state']?.toString() ?? 'UNKNOWN',
              connected: true,
            ),
          ),
        );
        view.info = view.info.copyWith(
          state: data['state']?.toString(),
          workspace: data['workspace']?.toString(),
          model: data['model']?.toString(),
          latestMessage: data['latestMessage']?.toString(),
          latestActivity: data['latestActivity']?.toString(),
          lastActivity: data['lastActivity']?.toString(),
          hasPendingPermission: data['pendingApproval'] != null,
          connected: true,
          title: data['title']?.toString(),
          unreadCount: focusedSessionId == id ? 0 : view.info.unreadCount,
        );
        final msgs = data['messages'];
        if (msgs is List) {
          final incoming = msgs
              .whereType<Map>()
              .map((e) =>
                  CdpAgentMessage.fromJson(Map<String, dynamic>.from(e)))
              .toList();
          view.messages = _mergeMessages(view.messages, incoming);
        }
        if (data['plan'] is Map) {
          view.plan = CdpAgentPlan.fromJson(
              Map<String, dynamic>.from(data['plan'] as Map));
        }
        if (data['pendingApproval'] is Map) {
          view.pendingApproval = CdpPermissionRequest.fromJson(
              Map<String, dynamic>.from(data['pendingApproval'] as Map));
        } else if (data.containsKey('pendingApproval')) {
          view.pendingApproval = null;
        }
        if (data['fileChanges'] is Map) {
          view.fileChanges = CdpFileChanges.fromJson(
              Map<String, dynamic>.from(data['fileChanges'] as Map));
        }
        if (data['activity'] is List) {
          view.activity = (data['activity'] as List)
              .whereType<Map>()
              .map((e) =>
                  CdpActivityEvent.fromJson(Map<String, dynamic>.from(e)))
              .toList();
        }
        if (data['extractionNotes'] is List) {
          view.extractionNotes = (data['extractionNotes'] as List)
              .map((e) => e.toString())
              .toList();
        }
        if (data['capabilities'] is Map) {
          view.capabilities = Map<String, String>.from(
            (data['capabilities'] as Map).map(
              (k, v) => MapEntry(k.toString(), v.toString()),
            ),
          );
        }
        summary = CdpStatusSummary.fromSessions(
            sessions.values.map((e) => e.info));
        notifyListeners();
        break;
      case 'agent_state_changed':
        final id = data['sessionId']?.toString();
        if (id == null) return;
        final view = sessions[id];
        if (view == null) return;
        view.info = view.info.copyWith(
          state: data['state']?.toString(),
          workspace: data['workspace']?.toString(),
          model: data['model']?.toString(),
          latestMessage: data['latestMessage']?.toString(),
          latestActivity: data['latestActivity']?.toString(),
          hasPendingPermission: data['hasPendingPermission'] == true,
        );
        summary = CdpStatusSummary.fromSessions(
            sessions.values.map((e) => e.info));
        notifyListeners();
        break;
      case 'agent_message':
        final id = data['sessionId']?.toString();
        final m = data['message'];
        if (id == null || m is! Map) return;
        final view = sessions[id];
        if (view == null) return;
        final msg =
            CdpAgentMessage.fromJson(Map<String, dynamic>.from(m));
        view.messages = _mergeMessages(view.messages, [msg]);
        view.info = view.info.copyWith(
          latestMessage: msg.text.slice120(),
          unreadCount: focusedSessionId == id
              ? 0
              : view.info.unreadCount + (msg.role == 'user' ? 0 : 1),
        );
        notifyListeners();
        break;
      case 'agent_message_delta':
        final id = data['sessionId']?.toString();
        final mid = data['messageId']?.toString();
        final text = data['text']?.toString();
        if (id == null || mid == null || text == null) return;
        final view = sessions[id];
        if (view == null) return;
        final status = data['status']?.toString();
        view.messages = [
          for (final m in view.messages)
            if (m.id == mid)
              m.copyWith(text: text, status: status ?? m.status)
            else
              m
        ];
        view.info = view.info.copyWith(latestMessage: text.slice120());
        notifyListeners();
        break;
      case 'permission_request':
        final id = data['sessionId']?.toString();
        final req = data['request'];
        if (id == null || req is! Map) return;
        final view = sessions[id];
        if (view == null) return;
        view.pendingApproval = CdpPermissionRequest.fromJson(
            Map<String, dynamic>.from(req));
        view.info = view.info.copyWith(
          state: 'WAITING_FOR_PERMISSION',
          hasPendingPermission: true,
        );
        notifyListeners();
        break;
      case 'permission_resolved':
        final id = data['sessionId']?.toString();
        if (id == null) return;
        final view = sessions[id];
        if (view == null) return;
        view.pendingApproval = null;
        view.info = view.info.copyWith(hasPendingPermission: false);
        notifyListeners();
        break;
      case 'agent_plan_changed':
      case 'agent_plan':
        final id = data['sessionId']?.toString();
        if (id == null) return;
        final view = sessions[id];
        if (view == null) return;
        if (data['plan'] is Map) {
          view.plan = CdpAgentPlan.fromJson(
              Map<String, dynamic>.from(data['plan'] as Map));
        }
        notifyListeners();
        break;
      case 'file_changed':
        final id = data['sessionId']?.toString();
        if (id == null) return;
        final view = sessions[id];
        if (view == null) return;
        if (data['fileChanges'] is Map) {
          view.fileChanges = CdpFileChanges.fromJson(
              Map<String, dynamic>.from(data['fileChanges'] as Map));
        }
        notifyListeners();
        break;
      case 'activity_event':
        final id = data['sessionId']?.toString();
        final ev = data['event'];
        if (id == null || ev is! Map) return;
        final view = sessions[id];
        if (view == null) return;
        final event =
            CdpActivityEvent.fromJson(Map<String, dynamic>.from(ev));
        view.activity = [...view.activity, event];
        view.info = view.info.copyWith(latestActivity: event.text);
        notifyListeners();
        break;
      case 'agent_completed':
        final id = data['sessionId']?.toString();
        if (id == null) return;
        final view = sessions[id];
        if (view == null) return;
        view.info = view.info.copyWith(state: 'COMPLETED');
        view.activity = [
          ...view.activity,
          CdpActivityEvent(
            id: 'done-${DateTime.now().millisecondsSinceEpoch}',
            text: 'Agent completed',
            kind: 'completed',
            timestamp: DateTime.now().toIso8601String(),
          ),
        ];
        notifyListeners();
        break;
      case 'agent_error':
        final id = data['sessionId']?.toString();
        if (id == null) return;
        final view = sessions[id];
        if (view == null) return;
        view.info = view.info.copyWith(state: 'ERROR');
        notifyListeners();
        break;
      default:
        break;
    }
  }

  /// Merge by id; grow streaming text; reconcile optimistic local-* user msgs.
  static List<CdpAgentMessage> _mergeMessages(
    List<CdpAgentMessage> prev,
    List<CdpAgentMessage> incoming,
  ) {
    if (incoming.isEmpty) return prev;
    final byId = <String, CdpAgentMessage>{
      for (final m in prev) m.id: m,
    };

    for (final msg in incoming) {
      if (!msg.id.startsWith('local-') && msg.role == 'user') {
        final localKey = byId.keys.cast<String?>().firstWhere(
              (id) =>
                  id != null &&
                  id.startsWith('local-') &&
                  byId[id]!.role == 'user' &&
                  (byId[id]!.text == msg.text ||
                      msg.text.startsWith(byId[id]!.text) ||
                      byId[id]!.text.startsWith(msg.text.length > 80
                          ? msg.text.substring(0, 80)
                          : msg.text)),
              orElse: () => null,
            );
        if (localKey != null) byId.remove(localKey);
      }
      final old = byId[msg.id];
      if (old == null) {
        byId[msg.id] = msg;
      } else {
        final text =
            msg.text.length >= old.text.length ? msg.text : old.text;
        byId[msg.id] = old.copyWith(
          text: text,
          status: msg.status ?? old.status,
          role: msg.role,
        );
      }
    }

    final nextIds = incoming.map((m) => m.id).toSet();
    final ordered = <CdpAgentMessage>[];
    for (final m in prev) {
      if (!nextIds.contains(m.id) && byId.containsKey(m.id)) {
        ordered.add(byId[m.id]!);
      }
    }
    for (final m in incoming) {
      final merged = byId[m.id];
      if (merged == null) continue;
      final idx = ordered.indexWhere((o) => o.id == m.id);
      if (idx >= 0) {
        ordered[idx] = merged;
      } else {
        ordered.add(merged);
      }
    }
    if (ordered.length > 120) {
      return ordered.sublist(ordered.length - 120);
    }
    return ordered;
  }
}

extension on String {
  String slice120() => length <= 120 ? this : '${substring(0, 120)}…';
}
