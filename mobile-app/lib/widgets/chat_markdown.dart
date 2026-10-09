import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_highlight/themes/atom-one-dark.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
// Never reference the package's global `highlight`: it registers every language and defeats tree-shaking.
import 'package:highlight/highlight.dart' show Highlight, Mode, Node;
import 'package:highlight/languages/bash.dart';
import 'package:highlight/languages/css.dart';
import 'package:highlight/languages/dart.dart';
import 'package:highlight/languages/diff.dart';
import 'package:highlight/languages/go.dart';
import 'package:highlight/languages/java.dart';
import 'package:highlight/languages/javascript.dart';
import 'package:highlight/languages/json.dart';
import 'package:highlight/languages/kotlin.dart';
import 'package:highlight/languages/markdown.dart';
import 'package:highlight/languages/python.dart';
import 'package:highlight/languages/rust.dart';
import 'package:highlight/languages/shell.dart';
import 'package:highlight/languages/sql.dart';
import 'package:highlight/languages/swift.dart';
import 'package:highlight/languages/typescript.dart';
import 'package:highlight/languages/xml.dart';
import 'package:highlight/languages/yaml.dart';
import 'package:markdown/markdown.dart' as md;

import '../theme/app_theme.dart';

const _codeBg = Color(0xFF1A1C22);
const _mono = TextStyle(fontFamily: 'monospace', fontSize: 12.5, height: 1.45, color: Color(0xFFE2E8F0));

/// Assistant markdown, styled like Cursor's chat, with highlighted code blocks.
class ChatMarkdown extends StatelessWidget {
  final String text;

  /// The long-press / right-click menu on the text; null keeps the platform's selection menu.
  final EditableTextContextMenuBuilder? contextMenuBuilder;
  const ChatMarkdown(this.text, {super.key, this.contextMenuBuilder});

  static final MarkdownStyleSheet _sheet = sheet();

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

  static final Map<String, MarkdownElementBuilder> _builders = {'code': _CodeBlockBuilder()};

  @override
  Widget build(BuildContext context) {
    return MarkdownBody(
      data: text.trim(),
      selectable: true,
      softLineBreak: true,
      styleSheet: _sheet,
      builders: _builders,
      // Transcripts are untrusted: never fetch remote images (that leaks the phone's IP to whoever wrote the URL).
      imageBuilder: (uri, title, alt) => _ImagePlaceholder(alt: alt, host: uri.host),
      onTapLink: (text, href, title) => confirmLink(context, href),
      contextMenuBuilder: contextMenuBuilder ?? _platformMenu,
    );
  }

  static Widget _platformMenu(BuildContext context, EditableTextState state) =>
      AdaptiveTextSelectionToolbar.editableText(editableTextState: state);

  /// Shows the full destination before anything happens; only https links are offered.
  static Future<void> confirmLink(BuildContext context, String? href) async {
    final uri = Uri.tryParse(href ?? '');
    if (uri == null || uri.scheme != 'https' || uri.host.isEmpty) {
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(const SnackBar(content: Text('Only https links can be opened from a chat.')));
      return;
    }
    final copy = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Link to ${uri.host}'),
        content: SelectableText(uri.toString()),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Copy link')),
        ],
      ),
    );
    if (copy == true) await Clipboard.setData(ClipboardData(text: uri.toString()));
  }
}

class _ImagePlaceholder extends StatelessWidget {
  final String? alt;
  final String host;
  const _ImagePlaceholder({this.alt, required this.host});

  @override
  Widget build(BuildContext context) {
    final label = (alt ?? '').trim().isEmpty ? 'Image' : alt!.trim();
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(6), border: Border.all(color: Cr.border)),
      child: Text('🖼 $label${host.isEmpty ? '' : ' · $host'} (not loaded)',
          style: const TextStyle(color: Cr.textSecondary, fontSize: 12.5)),
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
class CodeBlock extends StatefulWidget {
  final String source;
  final String? language;
  const CodeBlock(this.source, {super.key, this.language});

  static final Map<String, Mode> _languages = {
    'bash': bash,
    'css': css,
    'dart': dart,
    'diff': diff,
    'go': go,
    'java': java,
    'javascript': javascript,
    'json': json,
    'kotlin': kotlin,
    'markdown': markdown,
    'python': python,
    'rust': rust,
    'shell': shell,
    'sql': sql,
    'swift': swift,
    'typescript': typescript,
    'xml': xml,
    'yaml': yaml,
  };
  static final _highlight = Highlight()..registerLanguages(_languages);

  /// Fence names (and each language's own aliases, like `ts` or `html`) to a registered language.
  static final Map<String, String> _lookup = {
    for (final e in _languages.entries) ...{
      e.key: e.key,
      for (final a in e.value.aliases ?? const <String>[]) a.toLowerCase(): e.key,
    },
    'shell': 'bash',
  };

  /// The highlighted text; an unknown or unparsable language is plain text.
  static List<TextSpan> highlightSpans(String source, String? language) {
    final lang = _lookup[language?.toLowerCase()];
    if (lang == null) return [TextSpan(text: source)];
    try {
      return _convert(_highlight.parse(source, language: lang).nodes ?? const []);
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
  State<CodeBlock> createState() => _CodeBlockState();
}

class _CodeBlockState extends State<CodeBlock> {
  late List<TextSpan> _spans = CodeBlock.highlightSpans(widget.source, widget.language);
  bool _copied = false;
  Timer? _resetCopied;

  @override
  void didUpdateWidget(covariant CodeBlock oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.source != widget.source || oldWidget.language != widget.language) {
      _spans = CodeBlock.highlightSpans(widget.source, widget.language);
    }
  }

  @override
  void dispose() {
    _resetCopied?.cancel();
    super.dispose();
  }

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.source));
    if (!mounted) return;
    setState(() => _copied = true);
    _resetCopied?.cancel();
    _resetCopied = Timer(const Duration(milliseconds: 1500), () {
      if (mounted) setState(() => _copied = false);
    });
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
            padding: const EdgeInsets.fromLTRB(12, 12, 44, 12),
            child: SelectableText.rich(TextSpan(style: _mono, children: _spans)),
          ),
          Positioned(
            top: 0,
            right: 0,
            child: IconButton(
              tooltip: _copied ? 'Copied' : 'Copy code',
              iconSize: 15,
              constraints: Cr.tapTarget,
              visualDensity: VisualDensity.standard,
              color: _copied ? Cr.success : Cr.textFaint,
              icon: Icon(_copied ? Icons.check_rounded : Icons.copy_rounded),
              onPressed: _copy,
            ),
          ),
        ],
      ),
    );
  }
}
