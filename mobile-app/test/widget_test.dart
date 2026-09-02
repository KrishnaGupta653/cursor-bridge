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

  testWidgets('App loads with connection UI in English', (WidgetTester tester) async {
    await pumpApp(tester);

    expect(find.textContaining('Not Connected'), findsWidgets);
    expect(find.text('Messages'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Narrow phone layout has no overflow', (WidgetTester tester) async {
    await pumpApp(tester, size: const Size(360, 640));

    expect(find.text('Messages'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
