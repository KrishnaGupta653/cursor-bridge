import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:cursor_remote/models/chat_models.dart';
import 'package:cursor_remote/screens/agent_control_center.dart';
import 'package:cursor_remote/screens/agent_session_screen.dart';
import 'package:cursor_remote/services/chat_store.dart';
import 'package:cursor_remote/theme/app_theme.dart';

const chatA = 'aaaaaaaa-1111-2222-3333-444444444444';
const chatB = 'bbbbbbbb-1111-2222-3333-444444444444';
const chatC = 'cccccccc-1111-2222-3333-444444444444';

Map<String, dynamic> row(String id, String title, String group, {bool pinned = false, String status = 'done'}) =>
    {'id': id, 'title': title, 'group': group, 'pinned': pinned, 'status': status, 'inSidebar': true};

/// A store whose sent commands are recorded instead of leaving the device.
(ChatStore, List<Map<String, dynamic>>) fakeStore() {
  final sent = <Map<String, dynamic>>[];
  final store = ChatStore(send: (c) async {
    sent.add(c);
    return null;
  });
  store.applyInbound({
    'type': 'chats',
    'sidebar': true,
    'offset': 0,
    'chats': [
      row(chatA, 'Fix login', 'cursor-remote', pinned: true),
      row(chatB, 'Add search', 'cursor-remote', status: 'running'),
      row(chatC, 'Docs pass', 'website'),
    ],
  });
  return (store, sent);
}

Map<String, dynamic> item(int seq, String role, String text, {Map<String, dynamic>? work}) =>
    {'seq': seq, 'id': '$chatB:$seq', 'role': role, 'text': text, if (work != null) 'work': work};

Future<void> pumpShell(WidgetTester tester, ChatStore store, {Size size = const Size(390, 844)}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(MaterialApp(theme: buildCrDarkTheme(), home: Scaffold(body: AgentsShell(store: store))));
  await tester.pump();
}

/// Spinners never settle, so pump past route and drawer transitions instead.
Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

/// Unmount first, then stop the store's watch-renew timer.
Future<void> finish(WidgetTester tester, ChatStore store) async {
  await tester.pumpWidget(const SizedBox());
  store.dispose();
}

void main() {
  test('sidebar groups pinned chats first, then repositories in order, and searches title or repo', () {
    final (store, _) = fakeStore();
    expect(store.sections.map((s) => s.name), ['Pinned', 'cursor-remote', 'website']);
    expect(store.sections.first.rows.single.title, 'Fix login');
    expect(store.sections[1].rows.single.title, 'Add search');
    expect(groupChats(store.chats, query: 'web').single.rows.single.id, chatC);
    expect(groupChats(store.chats, query: 'LOGIN').single.pinned, isTrue);
    expect(groupChats(store.chats, query: 'nothing'), isEmpty);
  });

  test('unified diffs parse into numbered added, removed and context lines', () {
    final lines = parseUnifiedDiff('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -3,2 +3,2 @@\n keep\n-old\n+new\n');
    expect(lines.map((l) => l.kind), [
      DiffLineKind.meta, DiffLineKind.meta, DiffLineKind.meta, DiffLineKind.hunk,
      DiffLineKind.context, DiffLineKind.removed, DiffLineKind.added,
    ]);
    expect([lines[4].oldNo, lines[4].newNo], [3, 3]);
    expect(lines[5].oldNo, 4);
    expect(lines[6].newNo, 4);
  });

  test('the store follows its own chat: get_chat, watch, deltas from fromSeq, and only its own replies', () async {
    final (store, sent) = fakeStore();
    await store.selectChat(chatB);
    addTearDown(store.dispose);
    expect(sent.last['type'], 'get_chat');
    expect(sent.last['chatId'], chatB);

    store.applyInbound({
      'type': 'chat', 'chatId': chatB, 'total': 3, 'hasOlder': false,
      'items': [item(0, 'user', 'hi'), item(1, 'assistant', 'partial'), item(2, 'user', 'more')],
    });
    await Future<void>.delayed(Duration.zero);
    expect(sent.last['type'], 'watch_chat');
    expect(sent.last['fromTotal'], 3);

    store.applyInbound({
      'type': 'chat_delta', 'chatId': chatB, 'fromSeq': 2, 'total': 4,
      'items': [item(2, 'user', 'more'), item(3, 'assistant', 'done')],
    });
    expect(store.thread!.items.map((i) => i.text), ['hi', 'partial', 'more', 'done']);
    store.applyInbound({'type': 'chat_delta', 'chatId': chatA, 'fromSeq': 0, 'total': 1, 'items': [item(0, 'user', 'x')]});
    expect(store.thread!.items.length, 4);

    expect(store.applyInbound({'type': 'chat_response', 'correlationId': 'someone-else', 'text': 'x'}), isFalse);
    expect(store.applyInbound({'type': 'command_result', 'correlationId': 'cli-1', 'success': true}), isFalse);
  });

  testWidgets('narrow screens show the sidebar first, then the chat with a Chats drawer', (tester) async {
    final (store, _) = fakeStore();
    await pumpShell(tester, store);
    expect(find.text('New Chat'), findsOneWidget);
    expect(find.text('Pinned'), findsOneWidget);
    expect(find.text('Repositories'), findsOneWidget);

    await tester.tap(find.text('Docs pass'));
    await tester.pump();
    expect(find.byTooltip('Chats'), findsOneWidget);
    expect(find.text('Pinned'), findsNothing);

    await tester.tap(find.byTooltip('Chats'));
    await settle(tester);
    expect(find.text('Pinned'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await finish(tester, store);
  });

  testWidgets('wide screens keep the sidebar beside the chat', (tester) async {
    final (store, _) = fakeStore();
    await pumpShell(tester, store, size: const Size(1200, 800));
    await tester.tap(find.text('Add search'));
    await tester.pump();
    expect(find.text('Pinned'), findsOneWidget);
    expect(find.byTooltip('Chats'), findsNothing);
    await finish(tester, store);
  });

  testWidgets('work groups expand to edits and commands', (tester) async {
    final (store, _) = fakeStore();
    await pumpShell(tester, store, size: const Size(1200, 800));
    await tester.tap(find.text('Add search'));
    store.applyInbound({
      'type': 'chat', 'chatId': chatB, 'total': 2, 'hasOlder': false,
      'items': [
        item(0, 'user', 'add search'),
        item(1, 'work', '', work: {
          'summary': 'Edited 1 file, ran 1 command',
          'edits': [{'path': '/r/lib/search.dart', 'kind': 'modified', 'added': 12, 'removed': 3}],
          'commands': ['flutter test'],
        }),
      ],
    });
    await tester.pump();
    expect(find.text('Edited 1 file, ran 1 command'), findsOneWidget);
    expect(find.text('\$ flutter test'), findsNothing);
    await tester.tap(find.text('Edited 1 file, ran 1 command'));
    await tester.pump();
    expect(find.text('\$ flutter test'), findsOneWidget);
    expect(find.text('search.dart'), findsOneWidget);
    await finish(tester, store);
  });

  testWidgets('approving needs a confirm tap and sends the exact request', (tester) async {
    final (store, sent) = fakeStore();
    await pumpShell(tester, store, size: const Size(1200, 800));
    await tester.tap(find.text('Add search'));
    await tester.pump();
    store.applyInbound({
      'type': 'composer_state', 'chatId': chatB,
      'state': {
        'chatId': chatB, 'running': true,
        'pending': {'id': 'req-abc123', 'chatId': chatB, 'command': 'npm install', 'approveLabel': 'Run', 'rejectLabel': 'Skip'},
      },
    });
    await tester.pump();
    expect(find.text('Waiting for your approval'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, 'Run'));
    await settle(tester);
    expect(find.text('Approve this request?'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await settle(tester);
    expect(sent.where((c) => c['type'] == 'approve_action'), isEmpty);

    await tester.tap(find.widgetWithText(FilledButton, 'Run'));
    await settle(tester);
    await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.widgetWithText(FilledButton, 'Run')));
    await settle(tester);
    final approve = sent.singleWhere((c) => c['type'] == 'approve_action');
    expect(approve['requestId'], 'req-abc123');
    expect(approve['chatId'], chatB);
    expect(approve['confirmed'], isTrue);
    await finish(tester, store);
  });

  testWidgets('a prompt Cursor refuses comes back into the empty composer', (tester) async {
    final (store, sent) = fakeStore();
    await pumpShell(tester, store, size: const Size(1200, 800));
    await tester.tap(find.text('Docs pass'));
    await tester.pump();
    store.applyInbound({'type': 'chat', 'chatId': chatC, 'total': 0, 'hasOlder': false, 'items': []});
    await tester.pump();

    await tester.enterText(find.byType(TextField).last, 'ship it');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pump();
    final prompt = sent.lastWhere((c) => c['type'] == 'agent_prompt');
    store.applyInbound({'type': 'command_result', 'correlationId': prompt['id'], 'success': false, 'error': 'draft on the Mac'});
    await tester.pump();
    expect(tester.widget<TextField>(find.byType(TextField).last).controller!.text, 'ship it');
    await finish(tester, store);
  });

  testWidgets('confirm dialog repeats the command being approved', (tester) async {
    await tester.pumpWidget(MaterialApp(home: Builder(builder: (context) {
      return TextButton(
        onPressed: () => confirmResolve(context, const PendingRequest(id: 'req-1', command: 'rm -rf build'), approve: false),
        child: const Text('open'),
      );
    })));
    await tester.tap(find.text('open'));
    await settle(tester);
    expect(find.text('Reject this request?'), findsOneWidget);
    expect(find.textContaining('rm -rf build', findRichText: true), findsWidgets);
  });

  test('failures clear only their own spinner; a lost delta reloads the chat', () async {
    final failing = ChatStore(send: (c) async => c['type'] == 'list_chats' ? 'Not connected' : null);
    await failing.refreshChats();
    expect(failing.loadingChats, isFalse);
    failing.dispose();

    final (store, sent) = fakeStore();
    await store.selectChat(chatA);
    final staleId = sent.last['id'] as String;
    await store.selectChat(chatB);
    store.applyInbound({'type': 'command_result', 'correlationId': staleId, 'success': false, 'error': 'gone'});
    expect(store.thread!.loading, isTrue, reason: 'a failure for chat A must not end chat B\'s load');

    store.applyInbound({
      'type': 'chat', 'chatId': chatB, 'total': 2, 'hasOlder': false,
      'items': [item(0, 'user', 'hi'), item(1, 'assistant', 'there')],
    });
    sent.clear();
    store.applyInbound({'type': 'chat_delta', 'chatId': chatB, 'fromSeq': 5, 'total': 6, 'items': [item(5, 'assistant', 'late')]});
    expect(store.thread!.items.length, 2);
    expect(sent.where((c) => c['type'] == 'get_chat').length, 1);
    store.applyInbound({'type': 'chat_delta', 'chatId': chatB, 'fromSeq': 5, 'total': 6, 'items': [item(5, 'assistant', 'late')]});
    expect(sent.where((c) => c['type'] == 'get_chat').length, 1, reason: 'one reload at a time');
    store.dispose();
  });

  test('each lost delta after a successful reload triggers its own reload', () async {
    final (store, sent) = fakeStore();
    addTearDown(store.dispose);
    await store.selectChat(chatB);
    void reload(int total) => store.applyInbound({
          'type': 'chat', 'chatId': chatB, 'total': total, 'hasOlder': false,
          'items': [for (var i = 0; i < total; i++) item(i, 'assistant', 'm$i')],
        });
    reload(2);
    sent.clear();
    int reloads() => sent.where((c) => c['type'] == 'get_chat').length;

    store.applyInbound({'type': 'chat_delta', 'chatId': chatB, 'fromSeq': 5, 'total': 6, 'items': [item(5, 'assistant', 'x')]});
    expect(reloads(), 1);
    reload(6);
    store.applyInbound({'type': 'chat_delta', 'chatId': chatB, 'fromSeq': 9, 'total': 10, 'items': [item(9, 'assistant', 'y')]});
    expect(reloads(), 2, reason: 'a second gap must reload again after the first reload succeeded');
    reload(10);
    store.applyInbound({'type': 'chat_delta', 'chatId': chatB, 'fromSeq': 10, 'total': 11, 'items': [item(10, 'assistant', 'z')]});
    expect(store.thread!.items.length, 11);
  });

  test('a draft never shows the previous chat\'s approval and follows the new chat once it has an ID', () async {
    final (store, sent) = fakeStore();
    store.applyInbound({
      'type': 'composer_state', 'chatId': chatA,
      'state': {'chatId': chatA, 'running': false, 'pending': {'id': 'req-1', 'chatId': chatA, 'command': 'rm -rf /'}},
    });
    store.startNewChat();
    expect(store.liveComposer, isNull);

    await store.sendPrompt('build it');
    final promptId = sent.last['id'] as String;
    store.applyInbound({'type': 'command_result', 'correlationId': promptId, 'success': true, 'data': {'chatId': chatC}});
    await Future<void>.delayed(Duration.zero);
    expect(store.draft, isFalse);
    expect(store.selectedChatId, chatC);
    expect(store.pendingPrompt, 'build it', reason: 'the prompt stays visible until the chat shows it');
    expect(store.awaitingReply, isTrue);
    store.dispose();
  });
}
