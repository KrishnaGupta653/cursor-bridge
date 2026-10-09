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

  test('registered languages and their aliases are highlighted; others stay plain text', () {
    bool styled(List<TextSpan> spans) =>
        spans.any((s) => s.style != null || (s.children ?? const []).whereType<TextSpan>().any((c) => c.style != null));
    expect(styled(CodeBlock.highlightSpans('final x = 1;\nvoid main() {}', 'dart')), isTrue);
    expect(styled(CodeBlock.highlightSpans('const a: number = 1;', 'ts')), isTrue);
    expect(styled(CodeBlock.highlightSpans('<div class="a"></div>', 'html')), isTrue);
    expect(styled(CodeBlock.highlightSpans('echo hi', 'sh')), isTrue);

    for (final lang in ['cobol', 'ruby', '', null]) {
      final spans = CodeBlock.highlightSpans('MOVE 1 TO X.', lang);
      expect(spans.single.text, 'MOVE 1 TO X.', reason: '$lang');
      expect(spans.single.style, isNull, reason: '$lang');
    }
  });

  testWidgets('a fenced block in an unknown language renders as plain monospace', (tester) async {
    await tester.pumpWidget(host('```cobol\nDISPLAY "HI".\n```'));
    expect(tester.takeException(), isNull);
    expect(find.byType(CodeBlock), findsOneWidget);
    expect(find.textContaining('DISPLAY "HI".', findRichText: true), findsOneWidget);
  });

  testWidgets('the code block copy button copies the exact code and shows a check for a moment', (tester) async {
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied = (call.arguments as Map)['text'] as String?;
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
    const code = 'void main() {\n  print("hi");\n}';
    await tester.pumpWidget(host('Run this:\n\n```dart\n$code\n```\n'));

    await tester.tap(find.byTooltip('Copy code'));
    await tester.pump();
    expect(copied, code);
    expect(find.byIcon(Icons.check_rounded), findsOneWidget);

    await tester.pump(const Duration(milliseconds: 1600));
    expect(find.byIcon(Icons.copy_rounded), findsOneWidget);
    expect(find.byTooltip('Copy code'), findsOneWidget);
  });
}
