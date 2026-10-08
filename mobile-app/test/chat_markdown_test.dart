import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:cursor_remote/widgets/chat_markdown.dart';

Widget host(String md) => MaterialApp(home: Scaffold(body: SingleChildScrollView(child: ChatMarkdown(md))));

void main() {
  testWidgets('remote images are never loaded', (tester) async {
    await tester.pumpWidget(host('Look: ![build log](https://tracker.example/pixel.png)'));
    expect(find.byType(Image), findsNothing);
    expect(find.textContaining('build log · tracker.example (not loaded)'), findsOneWidget);
  });

  testWidgets('https links ask first and only copy; other schemes are refused', (tester) async {
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied = (call.arguments as Map)['text'] as String?;
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
    await tester.pumpWidget(host('x'));
    final context = tester.element(find.byType(ChatMarkdown));

    ChatMarkdown.confirmLink(context, 'https://docs.example/page?a=1');
    await tester.pumpAndSettle();
    expect(find.text('Link to docs.example'), findsOneWidget);
    expect(find.text('https://docs.example/page?a=1'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(copied, isNull);

    ChatMarkdown.confirmLink(context, 'https://docs.example/page?a=1');
    await tester.pumpAndSettle();
    await tester.tap(find.text('Copy link'));
    await tester.pumpAndSettle();
    expect(copied, 'https://docs.example/page?a=1');

    for (final href in ['http://plain.example', 'javascript:alert(1)', 'file:///etc/passwd', null]) {
      ChatMarkdown.confirmLink(context, href);
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing, reason: '$href');
      expect(find.text('Only https links can be opened from a chat.'), findsOneWidget);
      ScaffoldMessenger.of(context).removeCurrentSnackBar();
      await tester.pumpAndSettle();
    }
  });
}
