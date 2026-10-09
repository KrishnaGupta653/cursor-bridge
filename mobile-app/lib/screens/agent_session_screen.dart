import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/chat_models.dart';
import '../services/chat_store.dart';
import '../theme/app_theme.dart';
import '../widgets/chat_markdown.dart';
import '../widgets/diff_viewer.dart';

/// Modes the composer offers, as named in Cursor's Agents window.
const kComposerModes = ['Agent', 'Ask', 'Plan'];

/// Asks the user to confirm approving or rejecting exactly [request]; true confirms.
Future<bool> confirmResolve(BuildContext context, PendingRequest request, {required bool approve}) async {
  final verb = approve ? request.approveLabel : request.rejectLabel;
  final result = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(approve ? 'Approve this request?' : 'Reject this request?'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            approve
                ? 'Cursor will run this on your Mac:'
                : 'Cursor will skip this and the agent continues without it:',
            style: const TextStyle(color: Cr.textSecondary, fontSize: 13),
          ),
          const SizedBox(height: 10),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 220),
            child: SingleChildScrollView(child: CodeBlock(request.shown)),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
        FilledButton(
          style: approve ? null : FilledButton.styleFrom(backgroundColor: Cr.danger),
          onPressed: () => Navigator.pop(context, true),
          child: Text(verb),
        ),
      ],
    ),
  );
  return result == true;
}

/// One chat, Cursor-style: messages and work groups, files changed, permission card, composer.
class AgentChatPane extends StatefulWidget {
  final ChatStore store;

  /// Opens the sidebar drawer on narrow screens; null hides the button.
  final VoidCallback? onOpenSidebar;

  const AgentChatPane({super.key, required this.store, this.onOpenSidebar});

  @override
  State<AgentChatPane> createState() => _AgentChatPaneState();
}

class _AgentChatPaneState extends State<AgentChatPane> {
  final _scroll = ScrollController();
  final _input = TextEditingController();
  final _focus = FocusNode();
  bool _stickToBottom = true;
  int _pendingNew = 0;
  int _lastCount = 0;
  int _lastTail = 0;
  String? _lastChat;

  /// Returning the same widget instance lets Flutter skip rebuilding an unchanged message,
  /// so a streaming reply does not re-render the markdown of every visible item.
  final Map<String, (ChatItem, Widget)> _itemViews = {};

  ChatStore get store => widget.store;

  Widget _itemView(ChatItem item) {
    final cached = _itemViews[item.id];
    if (cached != null &&
        (identical(cached.$1, item) || (cached.$1.text == item.text && cached.$1.work == null && item.work == null))) {
      return cached.$2;
    }
    final view = _ItemView(key: ValueKey(item.id), item: item, onOpenFile: _openDiff);
    if (_itemViews.length > 400) _itemViews.clear();
    _itemViews[item.id] = (item, view);
    return view;
  }

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    store.addListener(_onStore);
  }

  @override
  void didUpdateWidget(covariant AgentChatPane oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.store != widget.store) {
      oldWidget.store.removeListener(_onStore);
      widget.store.addListener(_onStore);
    }
  }

  @override
  void dispose() {
    store.removeListener(_onStore);
    _scroll.dispose();
    _input.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _onStore() {
    final failed = store.takeFailedPrompt();
    if (failed != null && _input.text.trim().isEmpty) {
      _input.value = TextEditingValue(text: failed, selection: TextSelection.collapsed(offset: failed.length));
    }
    final items = store.thread?.items ?? const <ChatItem>[];
    final count = items.length;
    // The last answer grows in place while it streams; follow that too, not just new items.
    final tail = items.isEmpty ? 0 : items.last.text.length;
    final chat = store.selectedChatId;
    if (chat != _lastChat) {
      _lastChat = chat;
      _lastCount = count;
      _lastTail = tail;
      _itemViews.clear();
      _stickToBottom = true;
      _pendingNew = 0;
      WidgetsBinding.instance.addPostFrameCallback((_) => _jumpToEnd());
      return;
    }
    if (count == _lastCount && tail == _lastTail) return;
    final grew = count > _lastCount;
    _lastCount = count;
    _lastTail = tail;
    if (_stickToBottom) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToEnd());
    } else if (grew && mounted) {
      setState(() => _pendingNew++);
    }
  }

  void _onScroll() {
    if (!_scroll.hasClients) return;
    final pos = _scroll.position;
    final atBottom = pos.pixels >= pos.maxScrollExtent - 80;
    if (atBottom != _stickToBottom) {
      setState(() {
        _stickToBottom = atBottom;
        if (atBottom) _pendingNew = 0;
      });
    }
  }

  void _jumpToEnd() {
    if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
  }

  void _scrollToEnd() {
    if (!_scroll.hasClients) return;
    _scroll.animateTo(_scroll.position.maxScrollExtent,
        duration: const Duration(milliseconds: 220), curve: Curves.easeOut);
    if (_pendingNew != 0) setState(() => _pendingNew = 0);
  }

  void _send() {
    final text = _input.text.trim();
    if (text.isEmpty || store.running) return;
    store.sendPrompt(text);
    _input.clear();
    _stickToBottom = true;
    WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToEnd());
  }

  void _openDiff(FileEdit file) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => DiffScreen(file: file, diff: store.fileDiff(file.path)),
    ));
  }

  Future<void> _resolve(PendingRequest request, bool approve) async {
    if (!await confirmResolve(context, request, approve: approve)) return;
    await store.resolve(request, approve: approve);
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) {
        final thread = store.thread;
        final composer = store.liveComposer;
        return ColoredBox(
          color: Cr.bg,
          child: Column(
            children: [
              _Header(store: store, onOpenSidebar: widget.onOpenSidebar),
              if (store.error != null) _ErrorBanner(message: store.error!, onClose: store.clearError),
              Expanded(child: _body(thread)),
              if (thread != null && thread.filesChanged.isNotEmpty)
                _FilesChanged(files: thread.filesChanged, onOpen: _openDiff),
              if (composer?.pending != null)
                _PermissionCard(
                  request: composer!.pending!,
                  onApprove: () => _resolve(composer.pending!, true),
                  onReject: () => _resolve(composer.pending!, false),
                ),
              _Composer(
                store: store,
                controller: _input,
                focus: _focus,
                onSend: _send,
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _body(ChatThread? thread) {
    if (store.draft) {
      return const _Placeholder(
        icon: Icons.add_comment_outlined,
        title: 'New chat',
        body: 'Type a prompt below. Cursor starts a new chat in its Agents window.',
      );
    }
    if (thread == null) {
      return const _Placeholder(
        icon: Icons.forum_outlined,
        title: 'Pick a chat',
        body: 'Choose a chat from the sidebar, or start a new one.',
      );
    }
    if (thread.loading) {
      return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    }
    final items = thread.items;
    final pending = store.pendingPrompt;
    final extra = (pending != null ? 1 : 0) + (store.running ? 1 : 0);
    final head = thread.hasOlder ? 1 : 0;
    if (items.isEmpty && pending == null) {
      return const _Placeholder(
        icon: Icons.chat_bubble_outline,
        title: 'No messages yet',
        body: 'This chat has no saved history on the Mac. Send a prompt to continue it.',
      );
    }
    return Stack(
      children: [
        ListView.builder(
          controller: _scroll,
          padding: const EdgeInsets.fromLTRB(18, 14, 18, 24),
          itemCount: head + items.length + extra,
          itemBuilder: (context, i) {
            if (i < head) {
              return Center(
                child: thread.loadingOlder
                    ? const Padding(
                        padding: EdgeInsets.all(8),
                        child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                      )
                    : TextButton.icon(
                        onPressed: store.loadOlder,
                        icon: const Icon(Icons.history_rounded, size: 16),
                        label: const Text('Load older'),
                      ),
              );
            }
            final index = i - head;
            if (index < items.length) return _itemView(items[index]);
            if (pending != null && index == items.length) {
              return Opacity(opacity: 0.6, child: _UserBubble(text: pending));
            }
            return const _Working();
          },
          findChildIndexCallback: (key) {
            if (key is! ValueKey<String>) return null;
            final index = items.indexWhere((it) => it.id == key.value);
            return index < 0 ? null : head + index;
          },
        ),
        if (_pendingNew > 0)
          Positioned(
            bottom: 10,
            left: 0,
            right: 0,
            child: Center(
              child: Material(
                color: Cr.accent,
                borderRadius: BorderRadius.circular(20),
                child: InkWell(
                  onTap: _scrollToEnd,
                  borderRadius: BorderRadius.circular(20),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                    child: Text('$_pendingNew new message${_pendingNew == 1 ? '' : 's'} ↓',
                        style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w600)),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

/// Status label for a chat, as Cursor shows it next to the row.
(String, Color, bool) chatStatus(String status, {bool running = false, bool waiting = false}) {
  if (waiting || status == 'waiting') return ('Waiting for you', Cr.warning, false);
  if (running || status == 'running') return ('Working', Cr.warning, true);
  if (status == 'error') return ('Error', Cr.danger, false);
  if (status == 'draft') return ('Draft', Cr.textFaint, false);
  return ('Idle', Cr.success, false);
}

class _Header extends StatelessWidget {
  final ChatStore store;
  final VoidCallback? onOpenSidebar;
  const _Header({required this.store, this.onOpenSidebar});

  @override
  Widget build(BuildContext context) {
    final row = store.selectedRow;
    final composer = store.liveComposer;
    final title = store.draft
        ? 'New chat'
        : (store.thread?.title.isNotEmpty == true ? store.thread!.title : (row?.title ?? 'Cursor Remote'));
    final (label, color, busy) = chatStatus(row?.status ?? 'done',
        running: store.running, waiting: composer?.pending != null);
    final subtitle = store.thread?.repoName ?? row?.group ?? '';
    return Container(
      height: 52,
      padding: const EdgeInsets.symmetric(horizontal: 8),
      decoration: const BoxDecoration(
        color: Cr.bgElevated,
        border: Border(bottom: BorderSide(color: Cr.borderSubtle)),
      ),
      child: Row(
        children: [
          if (onOpenSidebar != null)
            IconButton(
              tooltip: 'Chats',
              constraints: Cr.tapTarget,
              visualDensity: VisualDensity.standard,
              icon: const Icon(Icons.menu_rounded, size: 20),
              onPressed: onOpenSidebar,
            )
          else
            const SizedBox(width: 8),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: Cr.text, fontSize: 14.5, fontWeight: FontWeight.w600)),
                if (subtitle.isNotEmpty && !store.draft)
                  Text(subtitle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: Cr.textFaint, fontSize: 11.5)),
              ],
            ),
          ),
          if (!store.draft && store.thread != null)
            Padding(
              padding: const EdgeInsets.only(left: 8, right: 8),
              child: _StatusPill(label: label, color: color, busy: busy),
            ),
        ],
      ),
    );
  }
}

class _StatusPill extends StatelessWidget {
  final String label;
  final Color color;
  final bool busy;
  const _StatusPill({required this.label, required this.color, this.busy = false});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        busy
            ? SizedBox(width: 9, height: 9, child: CircularProgressIndicator(strokeWidth: 1.4, color: color))
            : Container(width: 7, height: 7, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
        const SizedBox(width: 6),
        Text(label, style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w600)),
      ]),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  final String message;
  final VoidCallback onClose;
  const _ErrorBanner({required this.message, required this.onClose});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: Cr.danger.withValues(alpha: 0.12),
      padding: const EdgeInsets.fromLTRB(14, 6, 4, 6),
      child: Row(children: [
        const Icon(Icons.error_outline_rounded, size: 16, color: Cr.danger),
        const SizedBox(width: 8),
        Expanded(child: Text(message, style: const TextStyle(color: Cr.text, fontSize: 12.5))),
        IconButton(
          tooltip: 'Dismiss',
          iconSize: 16,
          constraints: Cr.tapTarget,
          visualDensity: VisualDensity.standard,
          icon: const Icon(Icons.close_rounded),
          onPressed: onClose,
        ),
      ]),
    );
  }
}

class _Placeholder extends StatelessWidget {
  final IconData icon;
  final String title;
  final String body;
  const _Placeholder({required this.icon, required this.title, required this.body});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 38, color: Cr.textFaint),
          const SizedBox(height: 14),
          Text(title, style: const TextStyle(color: Cr.text, fontSize: 16, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          Text(body,
              textAlign: TextAlign.center,
              style: const TextStyle(color: Cr.textSecondary, fontSize: 13, height: 1.45)),
        ]),
      ),
    );
  }
}

/// The selection menu (long-press, or right-click) plus "Copy text" for the whole message.
EditableTextContextMenuBuilder messageMenu(String text) => (context, state) => AdaptiveTextSelectionToolbar.buttonItems(
      anchors: state.contextMenuAnchors,
      buttonItems: [
        ...state.contextMenuButtonItems,
        ContextMenuButtonItem(
          label: 'Copy text',
          onPressed: () {
            Clipboard.setData(ClipboardData(text: text));
            state.hideToolbar();
          },
        ),
      ],
    );

/// On web the browser's own right-click menu replaces [messageMenu], so it is off while the pointer is over a message.
class _MessageMenuRegion extends StatefulWidget {
  final Widget child;
  const _MessageMenuRegion({required this.child});

  @override
  State<_MessageMenuRegion> createState() => _MessageMenuRegionState();
}

class _MessageMenuRegionState extends State<_MessageMenuRegion> {
  bool _inside = false;

  void _set(bool inside) {
    if (inside == _inside) return;
    _inside = inside;
    inside ? BrowserContextMenu.disableContextMenu() : BrowserContextMenu.enableContextMenu();
  }

  @override
  void dispose() {
    _set(false);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!kIsWeb) return widget.child;
    return MouseRegion(onEnter: (_) => _set(true), onExit: (_) => _set(false), child: widget.child);
  }
}

class _ItemView extends StatelessWidget {
  final ChatItem item;
  final ValueChanged<FileEdit> onOpenFile;
  const _ItemView({super.key, required this.item, required this.onOpenFile});

  @override
  Widget build(BuildContext context) {
    switch (item.role) {
      case 'user':
        return _UserBubble(text: item.text);
      case 'work':
        return item.work == null ? const SizedBox.shrink() : WorkGroup(work: item.work!, onOpenFile: onOpenFile);
      default:
        return Padding(
          padding: const EdgeInsets.only(bottom: 16),
          child: _MessageMenuRegion(child: ChatMarkdown(item.text, contextMenuBuilder: messageMenu(item.text))),
        );
    }
  }
}

class _UserBubble extends StatelessWidget {
  final String text;
  const _UserBubble({required this.text});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
          decoration: BoxDecoration(
            color: Cr.userBubble,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: Cr.borderSubtle),
          ),
          child: _MessageMenuRegion(
            child: SelectableText(text,
                contextMenuBuilder: messageMenu(text),
                style: const TextStyle(color: Cr.text, fontSize: 14.5, height: 1.45)),
          ),
        ),
      ),
    );
  }
}

/// Collapsible "Edited N files, ran N commands" group for one turn of tool use.
class WorkGroup extends StatefulWidget {
  final WorkSummary work;
  final ValueChanged<FileEdit> onOpenFile;
  const WorkGroup({super.key, required this.work, required this.onOpenFile});

  @override
  State<WorkGroup> createState() => _WorkGroupState();
}

class _WorkGroupState extends State<WorkGroup> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final w = widget.work;
    final hasDetail = w.edits.isNotEmpty || w.commands.isNotEmpty || w.notes.isNotEmpty;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(6),
            onTap: hasDetail ? () => setState(() => _open = !_open) : null,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(w.edits.isNotEmpty ? Icons.edit_note_rounded : Icons.bolt_rounded,
                    size: 16, color: Cr.textFaint),
                const SizedBox(width: 6),
                Flexible(
                  child: Text(w.summary.isEmpty ? 'Worked' : w.summary,
                      style: const TextStyle(color: Cr.textSecondary, fontSize: 12.5, fontWeight: FontWeight.w500)),
                ),
                if (hasDetail)
                  Icon(_open ? Icons.expand_less_rounded : Icons.expand_more_rounded, size: 16, color: Cr.textFaint),
              ]),
            ),
          ),
          if (_open)
            Container(
              margin: const EdgeInsets.only(top: 4, left: 4),
              padding: const EdgeInsets.only(left: 12),
              decoration: const BoxDecoration(border: Border(left: BorderSide(color: Cr.border))),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final e in w.edits)
                    InkWell(
                      onTap: e.kind == 'deleted' ? null : () => widget.onOpenFile(e),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        child: Row(children: [
                          Icon(_kindIcon(e.kind), size: 14, color: Cr.textFaint),
                          const SizedBox(width: 6),
                          Flexible(
                            child: Text(e.name,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(color: Cr.link, fontSize: 12.5)),
                          ),
                          const SizedBox(width: 8),
                          DiffCounts(added: e.added, removed: e.removed),
                        ]),
                      ),
                    ),
                  for (final c in w.commands)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 3),
                      child: Text('\$ $c',
                          style: const TextStyle(fontFamily: 'monospace', fontSize: 12, color: Cr.textSecondary)),
                    ),
                  for (final n in w.notes)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 2),
                      child: Text(n, style: const TextStyle(fontSize: 12, color: Cr.textFaint)),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

IconData _kindIcon(String kind) => switch (kind) {
      'added' => Icons.note_add_outlined,
      'deleted' => Icons.delete_outline_rounded,
      _ => Icons.description_outlined,
    };

class _Working extends StatelessWidget {
  const _Working();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: 8),
      child: Row(children: [
        SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.5, color: Cr.textSecondary)),
        SizedBox(width: 10),
        Text('Working…', style: TextStyle(color: Cr.textSecondary, fontSize: 12)),
      ]),
    );
  }
}

/// "N Files Changed" panel above the composer; tapping a file opens its diff.
class _FilesChanged extends StatefulWidget {
  final List<FileEdit> files;
  final ValueChanged<FileEdit> onOpen;
  const _FilesChanged({required this.files, required this.onOpen});

  @override
  State<_FilesChanged> createState() => _FilesChangedState();
}

class _FilesChangedState extends State<_FilesChanged> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final files = widget.files;
    final added = files.fold<int>(0, (s, f) => s + f.added);
    final removed = files.fold<int>(0, (s, f) => s + f.removed);
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 0, 12, 6),
      decoration: BoxDecoration(
        color: Cr.surface,
        borderRadius: BorderRadius.circular(Cr.radiusMd),
        border: Border.all(color: Cr.borderSubtle),
      ),
      child: Column(
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(Cr.radiusMd),
            onTap: () => setState(() => _open = !_open),
            child: Container(
              constraints: const BoxConstraints(minHeight: 44),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
              child: Row(children: [
                Icon(_open ? Icons.expand_more_rounded : Icons.chevron_right_rounded, size: 18, color: Cr.textFaint),
                const SizedBox(width: 4),
                Text('${files.length} File${files.length == 1 ? '' : 's'} Changed',
                    style: const TextStyle(color: Cr.text, fontSize: 13, fontWeight: FontWeight.w600)),
                const SizedBox(width: 8),
                DiffCounts(added: added, removed: removed),
              ]),
            ),
          ),
          if (_open)
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 220),
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.only(bottom: 6),
                children: [
                  for (final f in files)
                    InkWell(
                      onTap: f.kind == 'deleted' ? null : () => widget.onOpen(f),
                      child: Container(
                        constraints: const BoxConstraints(minHeight: 44),
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                        child: Row(children: [
                          Icon(_kindIcon(f.kind), size: 15, color: Cr.textFaint),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text.rich(
                              TextSpan(children: [
                                TextSpan(text: f.name, style: const TextStyle(color: Cr.text)),
                                TextSpan(
                                  text: '  ${f.path}',
                                  style: const TextStyle(color: Cr.textFaint, fontSize: 11),
                                ),
                              ]),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 12.5),
                            ),
                          ),
                          const SizedBox(width: 8),
                          DiffCounts(added: f.added, removed: f.removed),
                        ]),
                      ),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// The agent is waiting for permission: shows the exact command with Approve and Reject.
class _PermissionCard extends StatelessWidget {
  final PendingRequest request;
  final VoidCallback onApprove;
  final VoidCallback onReject;
  const _PermissionCard({required this.request, required this.onApprove, required this.onReject});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 0, 12, 6),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: Cr.warning.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(Cr.radiusMd),
        border: Border.all(color: Cr.warning.withValues(alpha: 0.4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(children: [
            Icon(Icons.shield_outlined, size: 16, color: Cr.warning),
            SizedBox(width: 6),
            Text('Waiting for your approval',
                style: TextStyle(color: Cr.text, fontSize: 13, fontWeight: FontWeight.w600)),
          ]),
          const SizedBox(height: 8),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 140),
            child: SingleChildScrollView(child: CodeBlock(request.shown)),
          ),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              OutlinedButton(
                style: OutlinedButton.styleFrom(
                    minimumSize: const Size(64, 44), padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10)),
                onPressed: onReject,
                child: Text(request.rejectLabel),
              ),
              const SizedBox(width: 8),
              FilledButton(
                style: FilledButton.styleFrom(
                    minimumSize: const Size(64, 44), padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10)),
                onPressed: onApprove,
                child: Text(request.approveLabel),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  final ChatStore store;
  final TextEditingController controller;
  final FocusNode focus;
  final VoidCallback onSend;
  const _Composer({required this.store, required this.controller, required this.focus, required this.onSend});

  Future<void> _pickModel(BuildContext context) async {
    if (store.models.isEmpty) store.loadModels();
    final picked = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: Cr.surface,
      builder: (context) => ListenableBuilder(
        listenable: store,
        builder: (context, _) {
          final current = store.liveComposer?.model ?? '';
          if (store.models.isEmpty) {
            return SizedBox(
              height: 160,
              child: Center(
                child: store.loadingModels
                    ? const CircularProgressIndicator(strokeWidth: 2)
                    : const Text('No models found. Is the Agents window open in Cursor?',
                        style: TextStyle(color: Cr.textSecondary)),
              ),
            );
          }
          return SafeArea(
            child: ListView(
              shrinkWrap: true,
              children: [
                const Padding(
                  padding: EdgeInsets.fromLTRB(16, 14, 16, 6),
                  child: Text('Model', style: TextStyle(color: Cr.textFaint, fontSize: 12, fontWeight: FontWeight.w600)),
                ),
                for (final m in store.models)
                  ListTile(
                    dense: true,
                    title: Text(m),
                    trailing: current.toLowerCase().startsWith(m.toLowerCase())
                        ? const Icon(Icons.check_rounded, size: 18, color: Cr.accent)
                        : null,
                    onTap: () => Navigator.pop(context, m),
                  ),
              ],
            ),
          );
        },
      ),
    );
    if (picked != null) await store.setModel(picked);
  }

  @override
  Widget build(BuildContext context) {
    final composer = store.liveComposer;
    final running = store.running;
    final canAct = store.draft || store.selectedChatId != null;
    final meta = [
      if (composer?.branch.isNotEmpty == true) composer!.branch,
      if (composer?.environment.isNotEmpty == true) composer!.environment,
      if (composer?.contextPercent != null) 'Context ${composer!.contextPercent}%',
    ];
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
      decoration: const BoxDecoration(
        color: Cr.bgElevated,
        border: Border(top: BorderSide(color: Cr.borderSubtle)),
      ),
      child: SafeArea(
        top: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              decoration: BoxDecoration(
                color: Cr.surfaceHigh,
                borderRadius: BorderRadius.circular(Cr.radiusMd),
                border: Border.all(color: Cr.border),
              ),
              child: Column(
                children: [
                  CallbackShortcuts(
                    bindings: {
                      const SingleActivator(LogicalKeyboardKey.enter, meta: true): onSend,
                      const SingleActivator(LogicalKeyboardKey.enter, control: true): onSend,
                    },
                    child: TextField(
                      controller: controller,
                      focusNode: focus,
                      enabled: canAct,
                      minLines: 1,
                      maxLines: 6,
                      textInputAction: TextInputAction.newline,
                      style: const TextStyle(color: Cr.text, fontSize: 14.5),
                      decoration: InputDecoration(
                        hintText: store.draft ? 'Plan, build, or ask anything…' : 'Add a follow-up…',
                        filled: false,
                        border: InputBorder.none,
                        enabledBorder: InputBorder.none,
                        focusedBorder: InputBorder.none,
                        disabledBorder: InputBorder.none,
                        contentPadding: const EdgeInsets.fromLTRB(14, 12, 14, 6),
                      ),
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(8, 0, 6, 6),
                    child: Row(
                      children: [
                        if (composer?.canMode ?? true)
                          _ModeChip(
                            mode: composer?.mode ?? 'Agent',
                            enabled: canAct && !running,
                            onPick: store.setMode,
                          ),
                        const SizedBox(width: 6),
                        if (composer?.canModel ?? true)
                          Flexible(
                            child: _Chip(
                              icon: Icons.auto_awesome_outlined,
                              label: composer?.model.isNotEmpty == true ? composer!.model : 'Model',
                              onTap: canAct && !running ? () => _pickModel(context) : null,
                            ),
                          ),
                        const Spacer(),
                        if (running)
                          IconButton.filled(
                            tooltip: 'Stop',
                            constraints: Cr.tapTarget,
                            visualDensity: VisualDensity.standard,
                            style: IconButton.styleFrom(backgroundColor: Cr.surfaceHover),
                            icon: const Icon(Icons.stop_rounded, size: 18),
                            onPressed: store.canStop ? store.stop : null,
                          )
                        else
                          ValueListenableBuilder<TextEditingValue>(
                            valueListenable: controller,
                            builder: (context, value, _) => IconButton.filled(
                              tooltip: 'Send',
                              constraints: Cr.tapTarget,
                              visualDensity: VisualDensity.standard,
                              icon: const Icon(Icons.arrow_upward_rounded, size: 18),
                              onPressed: canAct && value.text.trim().isNotEmpty ? onSend : null,
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            if (meta.isNotEmpty || (!store.draft && store.selectedChatId != null && composer == null))
              Padding(
                padding: const EdgeInsets.only(top: 6, left: 4),
                child: Text(
                  meta.isNotEmpty ? meta.join('  ·  ') : 'Not open in Cursor — sending opens it there',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: Cr.textFaint, fontSize: 11.5),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  const _Chip({required this.icon, required this.label, this.onTap});

  @override
  Widget build(BuildContext context) {
    // The pill stays small; the transparent band around it makes the tap area 44 px tall.
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      excludeFromSemantics: true,
      onTap: onTap,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 44),
        child: Center(widthFactor: 1, heightFactor: 1, child: _pill()),
      ),
    );
  }

  Widget _pill() {
    return Material(
      color: Cr.surface,
      borderRadius: BorderRadius.circular(999),
      child: InkWell(
        borderRadius: BorderRadius.circular(999),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(icon, size: 13, color: onTap == null ? Cr.textFaint : Cr.textSecondary),
            const SizedBox(width: 5),
            Flexible(
              child: Text(label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                      color: onTap == null ? Cr.textFaint : Cr.textSecondary,
                      fontSize: 12,
                      fontWeight: FontWeight.w500)),
            ),
            const Icon(Icons.expand_more_rounded, size: 14, color: Cr.textFaint),
          ]),
        ),
      ),
    );
  }
}

class _ModeChip extends StatelessWidget {
  final String mode;
  final bool enabled;
  final Future<void> Function(String mode) onPick;
  const _ModeChip({required this.mode, required this.enabled, required this.onPick});

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<String>(
      enabled: enabled,
      tooltip: 'Mode',
      color: Cr.surfaceHigh,
      onSelected: onPick,
      itemBuilder: (context) => [
        for (final m in kComposerModes)
          CheckedPopupMenuItem(value: m, checked: m.toLowerCase() == mode.toLowerCase(), child: Text(m)),
      ],
      child: IgnorePointer(
        child: _Chip(
          icon: switch (mode.toLowerCase()) {
            'ask' => Icons.help_outline_rounded,
            'plan' => Icons.checklist_rounded,
            _ => Icons.all_inclusive_rounded,
          },
          label: mode,
          onTap: enabled ? () {} : null,
        ),
      ),
    );
  }
}
