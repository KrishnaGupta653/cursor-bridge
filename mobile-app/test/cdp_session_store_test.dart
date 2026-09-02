import 'package:flutter_test/flutter_test.dart';
import 'package:cursor_remote/models/cdp_models.dart';
import 'package:cursor_remote/services/cdp_session_store.dart';

void main() {
  test('CdpStatusSummary counts session buckets', () {
    final summary = CdpStatusSummary.fromSessions([
      const CdpSessionInfo(
          id: '1', title: 'a', state: 'RUNNING', connected: true),
      const CdpSessionInfo(
          id: '2',
          title: 'b',
          state: 'WAITING_FOR_PERMISSION',
          connected: true),
      const CdpSessionInfo(id: '3', title: 'c', state: 'IDLE', connected: true),
      const CdpSessionInfo(
          id: '4', title: 'd', state: 'ERROR', connected: false),
    ]);
    expect(summary.working, 1);
    expect(summary.waiting, 1);
    expect(summary.idle, 1);
    expect(summary.error, 1);
  });

  test('CdpSessionStore applies multi-session updates independently', () {
    final store = CdpSessionStore();
    store.applyInbound({
      'type': 'sessions',
      'sessions': [
        {
          'id': 'cursor-1',
          'title': 'project-a',
          'state': 'RUNNING',
          'connected': true,
          'latestMessage': 'Implementing API',
        },
        {
          'id': 'cursor-2',
          'title': 'project-b',
          'state': 'IDLE',
          'connected': true,
        },
      ],
    });
    expect(store.sessions.length, 2);

    store.applyInbound({
      'type': 'permission_request',
      'sessionId': 'cursor-1',
      'request': {
        'id': 'p1',
        'title': 'Permission Required',
        'detail': 'npm install',
      },
    });
    expect(store.sessions['cursor-1']!.pendingApproval?.detail, 'npm install');
    expect(store.sessions['cursor-2']!.pendingApproval, isNull);
    expect(store.sessions['cursor-1']!.info.state, 'WAITING_FOR_PERMISSION');
  });

  test('emojiForAgentState maps states', () {
    expect(emojiForAgentState('RUNNING'), '🟢');
    expect(emojiForAgentState('WAITING_FOR_PERMISSION'), '🟡');
    expect(emojiForAgentState('ERROR'), '🔴');
    expect(emojiForAgentState('IDLE'), '⚪');
  });
}
