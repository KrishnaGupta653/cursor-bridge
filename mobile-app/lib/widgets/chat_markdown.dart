import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_highlight/themes/atom-one-dark.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:highlight/highlight.dart' show highlight, Node;
import 'package:highlight/languages/all.dart' show allLanguages;
import 'package:markdown/markdown.dart' as md;

import '../theme/app_theme.dart';

const _codeBg = Color(0xFF1A1C22);
const _mono = TextStyle(fontFamily: 'monospace', fontSize: 12.5, height: 1.45, color: Color(0xFFE2E8F0));

/// Assistant markdown, styled like Cursor's chat, with highlighted code blocks.
class ChatMarkdown extends StatelessWidget {
  final String text;
  const ChatMarkdown(this.text, {super.key});

  static MarkdownStyleSheet sheet() {
    const base = TextStyle(color: Cr.text, fontSize: 14.5, height: 1.55);
    return MarkdownStyleSheet(
      p: base,
      pPadding: const EdgeInsets.only(bottom: 10),
      strong: base.copyWith(fontWeight: FontWeight.w700),
      em: base.copyWith(fontStyle: FontStyle.italic),
      a: base.copyWith(
        color: Cr.link,
        decoration: TextDecoration.underline,
        decorationColor: Cr.link.withValues(alpha: 0.4),
      ),
      code: base.copyWith(
        fontFamily: 'monospace',
        fontSize: 13,
        backgroundColor: _codeBg,
        color: const Color(0xFFE2E8F0),
      ),
      codeblockDecoration: BoxDecoration(
        color: _codeBg,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: Cr.border),
      ),
      codeblockPadding: EdgeInsets.zero,
      blockquote: base.copyWith(color: Cr.textSecondary),
      blockquoteDecoration: const BoxDecoration(
        border: Border(left: BorderSide(color: Cr.border, width: 3)),
      ),
      h1: base.copyWith(fontSize: 20, fontWeight: FontWeight.w700, height: 1.3),
      h2: base.copyWith(fontSize: 17, fontWeight: FontWeight.w700, height: 1.3),
      h3: base.copyWith(fontSize: 15, fontWeight: FontWeight.w700, height: 1.3),
      h1Padding: const EdgeInsets.only(top: 8, bottom: 8),
      h2Padding: const EdgeInsets.only(top: 6, bottom: 6),
      h3Padding: const EdgeInsets.only(top: 4, bottom: 4),
      listBullet: base,
      listIndent: 22,
      tableHead: base.copyWith(fontWeight: FontWeight.w600, color: Cr.textSecondary, fontSize: 13),
      tableBody: base.copyWith(fontSize: 13.5),
      tableBorder: TableBorder(
        horizontalInside: BorderSide(color: Cr.border.withValues(alpha: 0.9)),
        bottom: BorderSide(color: Cr.border.withValues(alpha: 0.9)),
      ),
      tableCellsPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      tableHeadAlign: TextAlign.left,
      tableColumnWidth: const FlexColumnWidth(),
      horizontalRuleDecoration: BoxDecoration(
        border: Border(top: BorderSide(color: Cr.border.withValues(alpha: 0.8))),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return MarkdownBody(
      data: text.trim(),
      selectable: true,
      softLineBreak: true,
      styleSheet: sheet(),
      builders: {'code': _CodeBlockBuilder()},
    );
  }
}

class _CodeBlockBuilder extends MarkdownElementBuilder {
  @override
  Widget? visitElementAfterWithContext(
      BuildContext context, md.Element element, TextStyle? preferredStyle, TextStyle? parentStyle) {
    final cls = element.attributes['class'] ?? '';
    final source = element.textContent;
    if (!cls.startsWith('language-') && !source.contains('\n')) return null;
    return CodeBlock(source.replaceFirst(RegExp(r'\n$'), ''),
        language: cls.startsWith('language-') ? cls.substring('language-'.length) : null);
  }
}

/// A scrollable, syntax-highlighted code block with a copy button.
class CodeBlock extends StatelessWidget {
  final String source;
  final String? language;
  const CodeBlock(this.source, {super.key, this.language});

  static const _aliases = {
    'ts': 'typescript',
    'js': 'javascript',
    'sh': 'bash',
    'shell': 'bash',
    'zsh': 'bash',
    'py': 'python',
    'yml': 'yaml',
    'md': 'markdown',
    'kt': 'kotlin',
    'rb': 'ruby',
  };

  List<TextSpan> _spans() {
    final lang = _aliases[language?.toLowerCase()] ?? language?.toLowerCase();
    if (lang == null || !allLanguages.containsKey(lang)) return [TextSpan(text: source)];
    try {
      return _convert(highlight.parse(source, language: lang).nodes ?? const []);
    } catch (_) {
      return [TextSpan(text: source)];
    }
  }

  static List<TextSpan> _convert(List<Node> nodes) {
    TextSpan walk(Node n) => n.value != null
        ? TextSpan(text: n.value, style: atomOneDarkTheme[n.className])
        : TextSpan(
            style: atomOneDarkTheme[n.className],
            children: (n.children ?? const <Node>[]).map(walk).toList());
    return nodes.map(walk).toList();
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: _codeBg,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: Cr.border),
      ),
      child: Stack(
        children: [
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(12, 12, 40, 12),
            child: SelectableText.rich(TextSpan(style: _mono, children: _spans())),
          ),
          Positioned(
            top: 2,
            right: 2,
            child: IconButton(
              tooltip: 'Copy',
              iconSize: 15,
              visualDensity: VisualDensity.compact,
              color: Cr.textFaint,
              icon: const Icon(Icons.copy_rounded),
              onPressed: () => Clipboard.setData(ClipboardData(text: source)),
            ),
          ),
        ],
      ),
    );
  }
}
