import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:cursor_remote/main.dart';

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
    expect(find.text('Connect'), findsOneWidget);
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

    expect(find.text('Connect'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
