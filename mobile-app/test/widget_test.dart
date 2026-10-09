import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:cursor_remote/main.dart';
import 'package:cursor_remote/services/connection.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  Future<void> pumpApp(
    WidgetTester tester, {
    Size size = const Size(390, 844),
  }) async {
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(const MyApp());
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pumpAndSettle(const Duration(milliseconds: 100));
  }

  testWidgets('Offline app shows the connection landing page', (WidgetTester tester) async {
    await pumpApp(tester);

    expect(find.text('Offline'), findsOneWidget);
    expect(find.text('Local'), findsOneWidget);
    expect(find.text('Tunnel'), findsOneWidget);
    expect(find.text('Relay'), findsOneWidget);
    expect(find.text('Connect with Session ID'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Relay tab joins a Cursor-created session', (WidgetTester tester) async {
    await pumpApp(tester);

    await tester.tap(find.text('Relay'));
    await tester.pumpAndSettle();

    expect(find.text('Connect with Session ID'), findsOneWidget);
    expect(find.text('Generate Session ID'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Narrow phone layout has no overflow', (WidgetTester tester) async {
    await pumpApp(tester, size: const Size(360, 640));

    expect(find.text('Connect with Session ID'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('A saved relay login reconnects on start without the landing page, and Log out returns to it',
      (WidgetTester tester) async {
    final token = 'a' * 43;
    final login = RelayLogin(sessionId: 'ABC123', deviceId: 'mobile-1', token: token,
        expiresAt: DateTime.now().add(const Duration(hours: 2)).millisecondsSinceEpoch);
    SharedPreferences.setMockInitialValues({RelayLogin.storageKey: jsonEncode(login.toJson())});
    final connected = Completer<void>();
    final paths = <String>[];
    final relay = MockClient((req) async {
      paths.add(req.url.path);
      if (req.url.path == '/api/connect') {
        await connected.future;
        return http.Response(jsonEncode({'success': true, 'protocolVersion': 2,
          'data': {'deviceId': 'mobile-1', 'credentialExpiresAt': login.expiresAt}}), 200);
      }
      if (req.url.path == '/api/poll') return http.Response(jsonEncode({'success': true, 'data': {'messages': []}}), 200);
      return http.Response(jsonEncode({'success': true, 'data': {}}), 200);
    });
    await tester.binding.setSurfaceSize(const Size(1100, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await http.runWithClient(() async {
      await tester.pumpWidget(MyApp(savedLogin: login));
      expect(find.text('Connect with Session ID'), findsNothing, reason: 'no landing page flash');
      await tester.pump();
      expect(find.text('Connecting…'), findsOneWidget);
      expect(find.text('Connect with Session ID'), findsNothing);
      expect(paths, ['/api/connect']);

      connected.complete();
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.text('Connecting…'), findsNothing);
      expect(find.text('Relay'), findsOneWidget);

      await tester.tap(find.text('Log out'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text("Log out of session ABC123? You'll need a new pairing code to connect again."), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Log out'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump(const Duration(milliseconds: 300));
    }, () => relay);

    expect(paths, contains('/api/disconnect'));
    expect(find.text('Connect with Session ID'), findsOneWidget);
    expect((await SharedPreferences.getInstance()).getString(RelayLogin.storageKey), isNull);
    expect(tester.takeException(), isNull);
  });

  for (final width in [360.0, 390.0, 480.0]) {
    testWidgets('Connected app bar fits a ${width.toInt()} px phone', (WidgetTester tester) async {
      final login = RelayLogin(sessionId: 'ABC123', deviceId: 'mobile-1', token: 'a' * 43,
          expiresAt: DateTime.now().add(const Duration(hours: 2)).millisecondsSinceEpoch);
      SharedPreferences.setMockInitialValues({RelayLogin.storageKey: jsonEncode(login.toJson())});
      final relay = MockClient((req) async {
        if (req.url.path == '/api/connect') {
          return http.Response(jsonEncode({'success': true, 'protocolVersion': 2,
            'data': {'deviceId': 'mobile-1', 'credentialExpiresAt': login.expiresAt}}), 200);
        }
        return http.Response(jsonEncode({'success': true, 'data': {'messages': []}}), 200);
      });
      // MediaQuery follows the view, not the test surface, so set the view like a real phone.
      tester.view.devicePixelRatio = 3;
      tester.view.physicalSize = Size(width * 3, 844 * 3);
      addTearDown(tester.view.reset);

      await http.runWithClient(() async {
        await tester.pumpWidget(MyApp(savedLogin: login));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 600));
        expect(find.text('Relay'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      }, () => relay);
    });
  }
}
