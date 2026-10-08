import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

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
}
