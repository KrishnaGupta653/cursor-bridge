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
      await tester.pumpWidget(MyApp(savedLogin: login, relayUrl: 'https://relay.test'));
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

  test('a ?session= link gives a valid session ID only, never a code, and a saved login wins', () {
    Uri link(String query) => Uri.parse('https://cursor-remote-app.vercel.app/?$query');
    expect(launchSessionId(link('session=ABC123'), null), 'ABC123');
    for (final bad in ['session=abc123', 'session=ABC12', 'session=ABC1234', 'session=ABC-12', 'session=', 'other=ABC123']) {
      expect(launchSessionId(link(bad), null), isNull, reason: bad);
    }
    expect(launchSessionId(link('code=ABC123'), null), isNull);
    expect(launchSessionId(link('pairingCode=ABC123'), null), isNull);
    final login = RelayLogin(sessionId: 'XYZ789', deviceId: 'mobile-1', token: 'a' * 43,
        expiresAt: DateTime.now().add(const Duration(hours: 2)).millisecondsSinceEpoch);
    expect(launchSessionId(link('session=ABC123'), login), isNull);
  });

  test('a pasted pairing code is found inside stray spaces or the whole Telegram line', () {
    final code = 'Ab_-${'9' * 39}';
    expect(extractPairingCode(code), code);
    expect(extractPairingCode(' \n$code\n'), code);
    expect(extractPairingCode('Or enter it by hand: $code'), code);
    expect(extractPairingCode('${code}x'), '${code}x', reason: 'too long is not silently cut');
    expect(extractPairingCode(' short '), 'short');
  });

  test('a one-tap pairing link needs a valid session and code', () {
    final code = 'c' * 43;
    Uri link(String query) => Uri.parse('https://cursor-remote-app.vercel.app/?$query');
    final ok = LaunchPairing.from(link('session=ABC123'), code)!;
    expect((ok.sessionId, ok.code), ('ABC123', code));
    expect(LaunchPairing.from(link('session=ABC123'), null), isNull);
    expect(LaunchPairing.from(link('session=ABC123'), 'c' * 42), isNull);
    expect(LaunchPairing.from(link('session=abc123'), code), isNull);
    expect(LaunchPairing.from(link(''), code), isNull);
  });

  testWidgets('a one-tap pairing link connects at once with its code, over a saved login',
      (WidgetTester tester) async {
    final code = 'c' * 43;
    final old = RelayLogin(sessionId: 'XYZ789', deviceId: 'mobile-1', token: 'a' * 43,
        expiresAt: DateTime.now().add(const Duration(hours: 2)).millisecondsSinceEpoch);
    SharedPreferences.setMockInitialValues({RelayLogin.storageKey: jsonEncode(old.toJson())});
    final connects = <http.Request>[];
    final relay = MockClient((req) async {
      if (req.url.path == '/api/connect') {
        connects.add(req);
        return http.Response(jsonEncode({'success': true, 'protocolVersion': 2,
          'data': {'deviceId': 'mobile-9', 'token': 'n' * 43, 'credentialExpiresAt': old.expiresAt}}), 200);
      }
      return http.Response(jsonEncode({'success': true, 'data': {'messages': []}}), 200);
    });
    await tester.binding.setSurfaceSize(const Size(1100, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await http.runWithClient(() async {
      await tester.pumpWidget(MyApp(savedLogin: old, launchPairing: LaunchPairing('ABC123', code), relayUrl: 'https://relay.test'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
    }, () => relay);
    expect(connects, hasLength(1));
    expect(jsonDecode(connects.single.body), containsPair('sessionId', 'ABC123'));
    expect(jsonDecode(connects.single.body), containsPair('pairingCode', code));
    expect(connects.single.headers['Authorization'], isNull);
    final saved = RelayLogin.fromJson(jsonDecode((await SharedPreferences.getInstance()).getString(RelayLogin.storageKey)!))!;
    expect((saved.sessionId, saved.token), ('ABC123', 'n' * 43));
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets("a link to another relay asks first; Cancel drops the link's session and code",
      (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues({});
    final requests = <http.Request>[];
    final relay = MockClient((req) async { requests.add(req); return http.Response('{}', 500); });
    await tester.binding.setSurfaceSize(const Size(1100, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await http.runWithClient(() async {
      await tester.pumpWidget(MyApp(relayUrl: 'https://mine.example', launchRelayUrl: 'https://other.example',
          launchPairing: LaunchPairing('ABC123', 'c' * 43)));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('Use this relay?'), findsOneWidget);
      expect(find.text('other.example'), findsOneWidget);
      expect(find.textContaining('You are using mine.example now.'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
    }, () => relay);
    expect(requests, isEmpty, reason: 'nothing goes to either relay');
    expect((await SharedPreferences.getInstance()).getString(RelayServer.storageKey), isNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets('confirming a link relay saves it and pairs through it', (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues({});
    final code = 'c' * 43;
    final hosts = <String>[];
    final relay = MockClient((req) async {
      hosts.add(req.url.host);
      if (req.url.path == '/api/connect') {
        return http.Response(jsonEncode({'success': true, 'protocolVersion': 2, 'data': {'deviceId': 'mobile-9',
          'token': 'n' * 43, 'credentialExpiresAt': DateTime.now().add(const Duration(hours: 1)).millisecondsSinceEpoch}}), 200);
      }
      return http.Response(jsonEncode({'success': true, 'data': {'messages': []}}), 200);
    });
    await tester.binding.setSurfaceSize(const Size(1100, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await http.runWithClient(() async {
      await tester.pumpWidget(MyApp(launchRelayUrl: 'https://mine.vercel.app', launchPairing: LaunchPairing('ABC123', code)));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('mine.vercel.app'), findsOneWidget);
      await tester.tap(find.text('Use this relay'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
    }, () => relay);
    expect(hosts.toSet(), {'mine.vercel.app'});
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(RelayServer.storageKey), 'https://mine.vercel.app');
    expect(RelayLogin.fromJson(jsonDecode(prefs.getString(RelayLogin.storageKey)!))!.relayUrl, 'https://mine.vercel.app');
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('a session from the link pre-fills the Relay field over the last session ID, and no code',
      (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues({'last_session_id': 'OLD999', 'connection_type': 'local'});
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(MyApp(launchSessionId: launchSessionId(
        Uri.parse('https://cursor-remote-app.vercel.app/?session=K7Q2ZP&code=SECRET1&pairingCode=SECRET2'), null)));
    await tester.pumpAndSettle(const Duration(milliseconds: 100));

    expect(find.text('Connect with Session ID'), findsOneWidget);
    expect(find.text('K7Q2ZP'), findsOneWidget);
    expect(find.text('OLD999'), findsNothing);
    expect(find.textContaining('SECRET'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a saved login ignores the link\'s session', (WidgetTester tester) async {
    final login = RelayLogin(sessionId: 'XYZ789', deviceId: 'mobile-1', token: 'a' * 43,
        expiresAt: DateTime.now().add(const Duration(hours: 2)).millisecondsSinceEpoch);
    SharedPreferences.setMockInitialValues({RelayLogin.storageKey: jsonEncode(login.toJson())});
    final relay = MockClient((req) async => http.Response(jsonEncode({'success': true, 'protocolVersion': 2,
        'data': {'deviceId': 'mobile-1', 'credentialExpiresAt': login.expiresAt, 'messages': []}}), 200));
    await tester.binding.setSurfaceSize(const Size(1100, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await http.runWithClient(() async {
      await tester.pumpWidget(MyApp(savedLogin: login, launchSessionId: 'K7Q2ZP'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.text('K7Q2ZP'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    }, () => relay);
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
        await tester.pumpWidget(MyApp(savedLogin: login, relayUrl: 'https://relay.test'));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 600));
        expect(find.text('Relay'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      }, () => relay);
    });
  }
}
