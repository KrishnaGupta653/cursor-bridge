import 'package:flutter/material.dart';

import '../models/chat_models.dart';
import '../theme/app_theme.dart';

const _mono = TextStyle(fontFamily: 'monospace', fontSize: 12, height: 1.5);

/// "+12 −3" counts in Cursor's green/red.
class DiffCounts extends StatelessWidget {
  final int added;
  final int removed;
  const DiffCounts({super.key, required this.added, required this.removed});

  @override
  Widget build(BuildContext context) {
    return Text.rich(
      TextSpan(children: [
        if (added > 0 || removed == 0)
          TextSpan(text: '+$added', style: const TextStyle(color: Cr.success)),
        if (added > 0 && removed > 0) const TextSpan(text: ' '),
        if (removed > 0) TextSpan(text: '−$removed', style: const TextStyle(color: Cr.danger)),
      ]),
      style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, fontFamily: 'monospace'),
    );
  }
}

/// Unified diff with colored added/removed lines and old/new line numbers.
class DiffView extends StatelessWidget {
  final FileDiff diff;
  const DiffView({super.key, required this.diff});

  @override
  Widget build(BuildContext context) {
    final lines = diff.lines.where((l) => l.kind != DiffLineKind.meta).toList();
    if (lines.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('No changes in this file.', style: TextStyle(color: Cr.textSecondary)),
        ),
      );
    }
    final width = lines.fold<int>(0, (m, l) => l.text.length > m ? l.text.length : m);
    return Scrollbar(
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: SizedBox(
          width: (width * 7.4 + 120).clamp(MediaQuery.sizeOf(context).width, 6000).toDouble(),
          child: ListView.builder(
            itemCount: lines.length + (diff.truncated ? 1 : 0),
            itemBuilder: (context, i) {
              if (i == lines.length) {
                return const Padding(
                  padding: EdgeInsets.all(12),
                  child: Text('Diff truncated — open the file in Cursor to see the rest.',
                      style: TextStyle(color: Cr.textFaint, fontSize: 12)),
                );
              }
              return _DiffRow(line: lines[i]);
            },
          ),
        ),
      ),
    );
  }
}

class _DiffRow extends StatelessWidget {
  final DiffLine line;
  const _DiffRow({required this.line});

  @override
  Widget build(BuildContext context) {
    final (bg, fg, sign) = switch (line.kind) {
      DiffLineKind.added => (Cr.success.withValues(alpha: 0.12), const Color(0xFFB8F5D6), '+'),
      DiffLineKind.removed => (Cr.danger.withValues(alpha: 0.12), const Color(0xFFFFC9C9), '−'),
      DiffLineKind.hunk => (Cr.accentSoft, Cr.textSecondary, ''),
      _ => (Colors.transparent, Cr.text, ' '),
    };
    String no(int? n) => n == null ? '' : '$n';
    return Container(
      color: bg,
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (line.kind != DiffLineKind.hunk) ...[
            SizedBox(width: 36, child: Text(no(line.oldNo), textAlign: TextAlign.right, style: _mono.copyWith(color: Cr.textFaint))),
            SizedBox(width: 36, child: Text(no(line.newNo), textAlign: TextAlign.right, style: _mono.copyWith(color: Cr.textFaint))),
            SizedBox(width: 18, child: Text(sign, textAlign: TextAlign.center, style: _mono.copyWith(color: fg))),
          ],
          Expanded(child: Text(line.text, softWrap: false, style: _mono.copyWith(color: fg))),
        ],
      ),
    );
  }
}

/// Full-screen diff for one file, loaded on open.
class DiffScreen extends StatelessWidget {
  final FileEdit file;
  final Future<FileDiff> diff;
  const DiffScreen({super.key, required this.file, required this.diff});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Cr.bg,
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(file.name, overflow: TextOverflow.ellipsis),
            Text(file.path,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 11, color: Cr.textFaint, fontWeight: FontWeight.w400)),
          ],
        ),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 14),
            child: Center(child: DiffCounts(added: file.added, removed: file.removed)),
          ),
        ],
      ),
      body: FutureBuilder<FileDiff>(
        future: diff,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator(strokeWidth: 2));
          }
          if (snap.hasError) {
            final message = snap.error.toString().replaceFirst(RegExp(r'^(Bad state|TimeoutException): ?'), '');
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(message, textAlign: TextAlign.center, style: const TextStyle(color: Cr.textSecondary)),
              ),
            );
          }
          final d = snap.data!;
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (d.source == 'transcript')
                Container(
                  color: Cr.surfaceHigh,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  child: const Text('Reconstructed from the chat — this folder has no git history.',
                      style: TextStyle(color: Cr.textSecondary, fontSize: 12)),
                ),
              Expanded(child: DiffView(diff: d)),
            ],
          );
        },
      ),
    );
  }
}
