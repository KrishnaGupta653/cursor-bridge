import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:cursor_remote/services/connection.dart';

/// A local extension stand-in: pairs any code, then answers pings while [answering] is true.
class FakeExtension {
  late final HttpServer server;
  bool answering = true;
  final pings = <DateTime>[];

  Future<String> start() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final ws = await WebSocketTransformer.upgrade(req);
      ws.add(jsonEncode({'type': 'auth_required', 'protocolVersion': 2}));
      ws.listen((raw) {
        final msg = jsonDecode(raw as String) as Map;
        if (msg['type'] == 'pair') {
          ws.add(jsonEncode({'type': 'authenticated', 'protocolVersion': 2, 'scope': 'control', 'token': 't'}));
        } else if (msg['type'] == 'ping') {
          pings.add(DateTime.now());
          if (answering) ws.add(jsonEncode({'type': 'pong'}));
        }
      });
    });
    return 'ws://127.0.0.1:${server.port}';
  }

  Future<void> stop() => server.close(force: true);
}

Future<void> until(bool Function() done, {Duration timeout = const Duration(seconds: 3)}) async {
  final end = DateTime.now().add(timeout);
  while (!done()) {
    if (DateTime.now().isAfter(end)) throw TimeoutException('condition not met');
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('a local socket that stops answering pings is torn down and reconnects', () async {
    final ext = FakeExtension();
    final url = await ext.start();
    final conn = CursorConnection(relayUrl: 'https://relay.invalid')
      ..heartbeatInterval = const Duration(milliseconds: 60)
      ..askPairingCode = ({required bool relay}) async => 'code';
    final inbound = <Map<String, dynamic>>[];
    conn.onInbound = inbound.add;
    addTearDown(() async {
      conn.dispose();
      await ext.stop();
    });

    await conn.connectLocal(url, tunnel: false, label: 'test');
    await until(() => conn.connected);
    await until(() => ext.pings.length >= 3);
    expect(conn.connected, isTrue, reason: 'answered pings keep the connection');
    expect(inbound, isEmpty, reason: 'pongs never reach the chat store');

    ext.answering = false;
    await until(() => !conn.connected);
    expect(conn.reconnecting, isTrue);
  });

  test('only home, office and loopback hosts count as private for plain ws://', () {
    for (final h in ['192.168.1.20', '10.0.0.5', '172.16.4.1', '172.31.255.1', '127.0.0.1', '169.254.3.3',
        '100.101.102.103', 'localhost', 'MacBook.local', 'macbook', '::1', '[fd12::1]', 'fe80::1']) {
      expect(isPrivateHost(h), isTrue, reason: h);
    }
    for (final h in ['8.8.8.8', '172.32.0.1', '192.169.0.1', '100.128.0.1', 'my-mac.example.com',
        '2001:db8::1', '300.1.1.1', '']) {
      expect(isPrivateHost(h), isFalse, reason: h);
    }
  });

  test('held or denied relay commands count as failures for the chat store', () {
    expect(const SendResult().failure, isNull);
    expect(const SendResult(policyDecision: 'allow').failure, isNull);
    expect(const SendResult(policyDecision: 'approval_required').failure, contains('not sent'));
    expect(const SendResult(policyDecision: 'deny').failure, contains('blocked'));
    expect(const SendResult(error: 'HTTP 500', policyDecision: 'deny').failure, 'HTTP 500');
  });

  group('relay connect errors', () {
    Future<CursorConnection> connectWith(int status, String errorCode, {bool firstOk = true, VoidCallback? onGaveUp}) async {
      var calls = 0;
      final client = MockClient((req) async {
        calls++;
        if (firstOk && calls == 1) {
          return http.Response(jsonEncode({
            'success': true, 'protocolVersion': 2,
            'data': {'deviceId': 'mobile-1', 'token': 'a' * 43},
          }), 200);
        }
        if (req.url.path == '/api/poll') return http.Response(jsonEncode({'success': true, 'data': {'messages': []}}), 200);
        return http.Response(jsonEncode({'success': false, 'errorCode': errorCode}), status);
      });
      final conn = CursorConnection(relayUrl: 'https://relay.test')..onGaveUp = onGaveUp;
      await http.runWithClient(() async {
        await conn.connectRelay('ABC123', '123456');
        conn.setVisible(false);
        conn.connected = false;
        await conn.connectRelay('ABC123');
      }, () => client);
      return conn;
    }

    for (final (status, code) in [(409, 'PC_MUST_CONNECT_FIRST'), (429, 'RATE_LIMITED')]) {
      test('$status keeps the relay login and retries', () async {
        final conn = await connectWith(status, code);
        addTearDown(conn.dispose);
        expect(conn.relayHeaders('ABC123')['Authorization'], isNotNull);
        expect(conn.reconnecting, isTrue);
      });
    }

    test('401 clears the relay login and stops retrying', () async {
      var gaveUp = false;
      final conn = await connectWith(401, 'INVALID_CAPABILITY', onGaveUp: () => gaveUp = true);
      addTearDown(conn.dispose);
      expect(conn.relayHeaders('ABC123')['Authorization'], isNull);
      expect(conn.reconnecting, isFalse);
      expect(gaveUp, isTrue);
    });
  });

  group('saved relay login', () {
    final token = 'a' * 43;
    final later = DateTime.now().add(const Duration(hours: 20)).millisecondsSinceEpoch;
    String savedJson({int? expiresAt, bool reusable = false}) => jsonEncode({
          'sessionId': 'ABC123', 'deviceId': 'mobile-1', 'token': token,
          'credentialExpiresAt': expiresAt ?? later, if (reusable) 'reusableCode': true,
        });
    Future<String?> saved() async => (await SharedPreferences.getInstance()).getString(RelayLogin.storageKey);

    /// A relay stand-in: /api/connect and /api/poll answer with [connect] / [poll]; requests are recorded.
    ({List<http.Request> requests, MockClient client}) relay({
      http.Response Function(http.Request)? connect,
      http.Response Function(http.Request)? poll,
      http.Response Function(http.Request)? disconnect,
      Future<void>? connectDelay,
    }) {
      final requests = <http.Request>[];
      final client = MockClient((req) async {
        requests.add(req);
        if (req.url.path == '/api/connect') await connectDelay;
        return switch (req.url.path) {
          '/api/connect' => connect?.call(req) ??
              http.Response(jsonEncode({
                'success': true, 'protocolVersion': 2,
                'data': {'deviceId': 'mobile-1', if (!req.headers.containsKey('Authorization')) 'token': token,
                  'credentialExpiresAt': later},
              }), 200),
          '/api/poll' => poll?.call(req) ?? http.Response(jsonEncode({'success': true, 'data': {'messages': []}}), 200),
          '/api/disconnect' => disconnect?.call(req) ?? http.Response('{"success":true}', 200),
          _ => http.Response('{}', 404),
        };
      });
      return (requests: requests, client: client);
    }

    CursorConnection connection({VoidCallback? onGaveUp}) {
      final conn = CursorConnection(relayUrl: 'https://relay.test')
        ..onGaveUp = onGaveUp
        ..askPairingCode = ({required bool relay}) async => fail('no pairing code should be asked for');
      addTearDown(conn.dispose);
      return conn;
    }

    setUp(() => SharedPreferences.setMockInitialValues({}));

    test('is saved after pairing and restored by a fresh app start without a pairing code', () async {
      final fake = relay();
      await http.runWithClient(() async {
        final first = CursorConnection(relayUrl: 'https://relay.test');
        await first.connectRelay('abc123', 'p' * 43);
        expect(first.connected, isTrue);
        first.dispose();
        final stored = jsonDecode((await saved())!) as Map;
        expect(stored, {'sessionId': 'ABC123', 'deviceId': 'mobile-1', 'token': token, 'credentialExpiresAt': later});

        final restarted = connection();
        expect(await restarted.restoreRelayLogin(), isTrue);
        expect(restarted.connected, isTrue);
        expect(restarted.sessionId, 'ABC123');
        restarted.setVisible(false);
      }, () => fake.client);
      final reconnect = fake.requests.where((r) => r.url.path == '/api/connect').last;
      expect(reconnect.headers['Authorization'], 'Bearer $token');
      expect(jsonDecode(reconnect.body).containsKey('pairingCode'), isFalse);
      expect(fake.requests.every((r) => !r.url.toString().contains(token)), isTrue, reason: 'never in a URL');
    });

    test('a reusable-code pairing is remembered for the log-out wording', () async {
      final fake = relay(connect: (req) => http.Response(jsonEncode({
            'success': true, 'protocolVersion': 2,
            'data': {'deviceId': 'mobile-1', 'token': token, 'credentialExpiresAt': later,
              'pairing': {'reusable': true, 'usesLeft': 2}},
          }), 200));
      await http.runWithClient(() async {
        final conn = connection()..setVisible(false);
        await conn.connectRelay('ABC123', 'p' * 43);
        expect(conn.pairedWithReusableCode, isTrue);
      }, () => fake.client);
      expect(RelayLogin.fromJson(jsonDecode((await saved())!))!.reusableCode, isTrue);
    });

    for (final status in [401, 403]) {
      test('$status on reconnect clears it and says the session ended', () async {
        SharedPreferences.setMockInitialValues({RelayLogin.storageKey: savedJson()});
        var gaveUp = false;
        final fake = relay(connect: (_) => http.Response(jsonEncode({'success': false, 'errorCode': 'CREDENTIAL_REVOKED'}), status));
        final conn = connection(onGaveUp: () => gaveUp = true);
        await http.runWithClient(() => conn.restoreRelayLogin(), () => fake.client);
        expect(await saved(), isNull);
        expect(conn.relayHeaders('ABC123')['Authorization'], isNull);
        expect(conn.lastError, relaySessionEndedMessage);
        expect(gaveUp, isTrue);
        expect(conn.reconnecting, isFalse);
      });

      test('$status on poll clears it', () async {
        SharedPreferences.setMockInitialValues({RelayLogin.storageKey: savedJson()});
        final fake = relay(poll: (_) => http.Response('{"success":false}', status));
        final conn = connection();
        await http.runWithClient(() async {
          await conn.restoreRelayLogin();
          await until(() => !conn.connected);
        }, () => fake.client);
        expect(await saved(), isNull);
        expect(conn.relayHeaders('ABC123')['Authorization'], isNull);
        expect(conn.lastError, relaySessionEndedMessage);
      });
    }

    test('an expired login is ignored and cleared without contacting the relay', () async {
      SharedPreferences.setMockInitialValues({RelayLogin.storageKey: savedJson(expiresAt: DateTime.now().millisecondsSinceEpoch - 1)});
      final fake = relay();
      final conn = connection();
      final login = await RelayLogin.load();
      expect(login!.expired, isTrue);
      expect(await http.runWithClient(() => conn.restoreRelayLogin(login), () => fake.client), isFalse);
      expect(fake.requests, isEmpty);
      expect(await saved(), isNull);
      expect(conn.lastError, relaySessionEndedMessage);
    });

    test('a malformed saved login is dropped', () async {
      SharedPreferences.setMockInitialValues({RelayLogin.storageKey: '{"sessionId":"ABC123","token":"short"}'});
      expect(await RelayLogin.load(), isNull);
      expect(await saved(), isNull);
    });

    for (final (label, connect) in [
      ('a network error', (http.Request _) => throw http.ClientException('offline')),
      ('409', (http.Request _) => http.Response(jsonEncode({'success': false, 'errorCode': 'PC_MUST_CONNECT_FIRST'}), 409)),
      ('429', (http.Request _) => http.Response(jsonEncode({'success': false, 'errorCode': 'RATE_LIMITED'}), 429)),
    ]) {
      test('$label keeps it and retries', () async {
        SharedPreferences.setMockInitialValues({RelayLogin.storageKey: savedJson()});
        final fake = relay(connect: connect);
        final conn = connection();
        await http.runWithClient(() => conn.restoreRelayLogin(), () => fake.client);
        expect(await saved(), savedJson());
        expect(conn.relayHeaders('ABC123')['Authorization'], 'Bearer $token');
        expect(conn.reconnecting, isTrue);
        expect(conn.lastError, isNot(relaySessionEndedMessage));
      });
    }

    test('a used-up reusable pairing code gets its own message', () async {
      final fake = relay(connect: (_) => http.Response(jsonEncode({'success': false, 'errorCode': 'PAIRING_CODE_USED_UP'}), 403));
      final conn = connection();
      await http.runWithClient(() => conn.connectRelay('ABC123', 'p' * 43), () => fake.client);
      expect(conn.lastError, pairingCodeUsedUpMessage);
      expect(conn.reconnecting, isFalse);
    });

    for (final (label, disconnect) in [
      ('fails', (http.Request _) => http.Response('{}', 503)),
      ('is unreachable', (http.Request _) => throw http.ClientException('offline')),
    ]) {
      test('log out forgets the login everywhere even if /api/disconnect $label', () async {
        SharedPreferences.setMockInitialValues({RelayLogin.storageKey: savedJson()});
        final fake = relay(disconnect: disconnect);
        final conn = connection();
        String? warning;
        await http.runWithClient(() async {
          await conn.restoreRelayLogin();
          expect(conn.connected, isTrue);
          warning = await conn.logOut();
        }, () => fake.client);
        expect(warning, contains('until the session ends'));
        expect(fake.requests.last.url.path, '/api/disconnect');
        expect(fake.requests.last.headers['Authorization'], 'Bearer $token');
        expect(await saved(), isNull);
        expect(conn.relayHeaders('ABC123')['Authorization'], isNull);
        expect(conn.connected, isFalse);
        expect(conn.sessionId, isNull);
        expect(conn.relaySession, isNull);
        final polls = fake.requests.where((r) => r.url.path == '/api/poll').length;
        await Future<void>.delayed(const Duration(milliseconds: 50));
        expect(fake.requests.where((r) => r.url.path == '/api/poll').length, polls, reason: 'polling stopped');
      });
    }

    test('log out while the saved login is still reconnecting cancels it', () async {
      SharedPreferences.setMockInitialValues({RelayLogin.storageKey: savedJson()});
      final release = Completer<void>();
      final fake = relay(connectDelay: release.future);
      final conn = connection();
      await http.runWithClient(() async {
        final restoring = conn.restoreRelayLogin();
        await until(() => conn.connecting);
        await conn.logOut();
        release.complete();
        await restoring;
      }, () => fake.client);
      expect(conn.connected, isFalse);
      expect(await saved(), isNull);
      expect(fake.requests.map((r) => r.url.path), containsAll(['/api/disconnect', '/api/connect']));
    });
  });
}
