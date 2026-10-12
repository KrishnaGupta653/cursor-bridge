import 'package:flutter/material.dart';

import '../models/chat_models.dart';
import '../services/app_settings.dart';
import '../services/chat_store.dart';
import '../theme/app_theme.dart';
import 'agent_session_screen.dart';

/// Cursor Agents window for the phone: sidebar (New Chat, Search, Pinned,
/// repositories, More) beside the chat. Below [Cr.wideBreakpoint] the sidebar
/// is a drawer and the top bar shows the chat title and status.
class AgentsShell extends StatefulWidget {
  final ChatStore store;
  const AgentsShell({super.key, required this.store});

  @override
  State<AgentsShell> createState() => _AgentsShellState();
}

class _AgentsShellState extends State<AgentsShell> {
  final _scaffold = GlobalKey<ScaffoldState>();

  ChatStore get store => widget.store;

  bool get _picked => store.draft || store.selectedChatId != null;
  late bool _lastPicked;
  double _sidebarWidth = AppSettings().sidebarWidth ?? Cr.sidebarWidth;

  @override
  void initState() {
    super.initState();
    _lastPicked = _picked;
    store.addListener(_onStore);
  }

  @override
  void didUpdateWidget(covariant AgentsShell oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.store != widget.store) {
      oldWidget.store.removeListener(_onStore);
      widget.store.addListener(_onStore);
      _lastPicked = _picked;
    }
  }

  @override
  void dispose() {
    store.removeListener(_onStore);
    super.dispose();
  }

  /// The chat pane listens for itself; the shell only swaps between sidebar and chat.
  void _onStore() {
    if (_picked == _lastPicked) return;
    setState(() => _lastPicked = _picked);
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: store,
      builder: (context, child) => Title(title: tabTitle(store.attentionCount), color: Cr.bg, child: child!),
      child: _layout(),
    );
  }

  Widget _layout() {
    return LayoutBuilder(builder: (context, constraints) {
      final wide = constraints.maxWidth >= Cr.wideBreakpoint;
      void closeDrawer() {
        if (!wide && _scaffold.currentState?.isDrawerOpen == true) Navigator.of(context).pop();
      }

      final sidebar = AgentsSidebar(
        store: store,
        onSelect: (row) {
          store.selectChat(row.id);
          closeDrawer();
        },
        onNewChat: () {
          store.startNewChat();
          closeDrawer();
        },
      );
      if (wide) {
        final maxWidth = (constraints.maxWidth / 2).clamp(Cr.sidebarMinWidth, Cr.sidebarMaxWidth);
        final width = _sidebarWidth.clamp(Cr.sidebarMinWidth, maxWidth);
        return Row(children: [
          SizedBox(width: width, child: Material(color: Cr.bgElevated, child: sidebar)),
          _SidebarResizer(
            onDrag: (dx) => setState(() => _sidebarWidth = (width + dx).clamp(Cr.sidebarMinWidth, maxWidth)),
            onDragEnd: () => AppSettings().setSidebarWidth(_sidebarWidth),
            onReset: () {
              setState(() => _sidebarWidth = Cr.sidebarWidth);
              AppSettings().setSidebarWidth(null);
            },
          ),
          Expanded(child: AgentChatPane(store: store)),
        ]);
      }
      return Scaffold(
        key: _scaffold,
        backgroundColor: Cr.bg,
        drawer: Drawer(
          width: Cr.sidebarWidth,
          backgroundColor: Cr.bgElevated,
          shape: const RoundedRectangleBorder(),
          child: SafeArea(child: sidebar),
        ),
        body: _picked
            ? AgentChatPane(store: store, onOpenSidebar: () => _scaffold.currentState?.openDrawer())
            : Material(color: Cr.bgElevated, child: sidebar),
      );
    });
  }
}

/// The line between sidebar and chat: drag to resize, double-click to reset.
class _SidebarResizer extends StatelessWidget {
  final ValueChanged<double> onDrag;
  final VoidCallback onDragEnd;
  final VoidCallback onReset;
  const _SidebarResizer({required this.onDrag, required this.onDragEnd, required this.onReset});

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      cursor: SystemMouseCursors.resizeColumn,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onHorizontalDragUpdate: (d) => onDrag(d.delta.dx),
        onHorizontalDragEnd: (_) => onDragEnd(),
        onDoubleTap: onReset,
        child: SizedBox(
          width: 7,
          child: Center(child: Container(width: 1, color: Cr.borderSubtle)),
        ),
      ),
    );
  }
}

class AgentsSidebar extends StatefulWidget {
  final ChatStore store;
  final ValueChanged<ChatRow> onSelect;
  final VoidCallback onNewChat;
  const AgentsSidebar({super.key, required this.store, required this.onSelect, required this.onNewChat});

  @override
  State<AgentsSidebar> createState() => _AgentsSidebarState();
}

class _AgentsSidebarState extends State<AgentsSidebar> {
  late final TextEditingController _search = TextEditingController(text: widget.store.query);
  final Set<String> _collapsed = {};

  ChatStore get store => widget.store;

  /// Everything the sidebar shows. A streaming reply notifies the store many times a second
  /// without changing any of it, so those notifications skip the rebuild.
  Object _shown() {
    final c = store.liveComposer;
    return (
      store.chats,
      store.query,
      store.selectedChatId,
      store.draft,
      store.loadingChats,
      store.sidebarLive,
      store.hasMoreChats,
      c != null && c.running ? c.chatId : null,
    );
  }

  late Object _lastShown;

  @override
  void initState() {
    super.initState();
    _lastShown = _shown();
    store.addListener(_onStore);
  }

  @override
  void didUpdateWidget(covariant AgentsSidebar oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.store != widget.store) {
      oldWidget.store.removeListener(_onStore);
      widget.store.addListener(_onStore);
      _lastShown = _shown();
    }
  }

  @override
  void dispose() {
    store.removeListener(_onStore);
    _search.dispose();
    super.dispose();
  }

  void _onStore() {
    final shown = _shown();
    if (shown == _lastShown) return;
    setState(() => _lastShown = shown);
  }

  @override
  Widget build(BuildContext context) {
    final sections = store.sections;
    final pinned = sections.where((s) => s.pinned).toList();
    final repos = sections.where((s) => !s.pinned).toList();
    // Chat rows are built lazily as they scroll in; the few labels and headers are built up front.
    final entries = <Object>[
      if (store.chats.isEmpty)
        Padding(
          padding: const EdgeInsets.all(24),
          child: Center(
            child: store.loadingChats
                ? const CircularProgressIndicator(strokeWidth: 2)
                : Text(
                    store.sidebarLive
                        ? 'No chats yet. Tap New Chat to start one.'
                        : '${liveOffReasonText(store.liveOffReason)} Then refresh the list.',
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: Cr.textSecondary)),
          ),
        ),
      if (sections.isEmpty && store.chats.isNotEmpty)
        const Padding(
          padding: EdgeInsets.all(20),
          child: Text('No chats match your search.',
              textAlign: TextAlign.center, style: TextStyle(color: Cr.textSecondary, fontSize: 13)),
        ),
      for (final s in pinned) ...[
        const _SectionLabel('Pinned'),
        ...s.rows,
      ],
      if (repos.isNotEmpty) const _SectionLabel('Repositories'),
      for (final s in repos) ...[
        _GroupHeader(
          key: ValueKey('group:${s.name}'),
          name: s.name,
          count: s.rows.length,
          collapsed: _collapsed.contains(s.name),
          waiting: s.rows.any((r) => r.waiting),
          onTap: () =>
              setState(() => _collapsed.contains(s.name) ? _collapsed.remove(s.name) : _collapsed.add(s.name)),
        ),
        if (!_collapsed.contains(s.name)) ...s.rows,
      ],
      if (store.hasMoreChats)
        Padding(
          padding: const EdgeInsets.fromLTRB(10, 6, 10, 0),
          child: TextButton(
            onPressed: store.loadingChats ? null : store.loadMoreChats,
            child: Text(store.loadingChats ? 'Loading…' : 'More'),
          ),
        ),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(10, 10, 10, 6),
          child: Material(
            color: store.draft ? Cr.surfaceHover : Colors.transparent,
            borderRadius: BorderRadius.circular(Cr.radiusSm),
            child: InkWell(
              borderRadius: BorderRadius.circular(Cr.radiusSm),
              onTap: widget.onNewChat,
              child: const Padding(
                padding: EdgeInsets.symmetric(horizontal: 10, vertical: 9),
                child: Row(children: [
                  Icon(Icons.edit_square, size: 16, color: Cr.text),
                  SizedBox(width: 10),
                  Text('New Chat', style: TextStyle(color: Cr.text, fontSize: 13.5, fontWeight: FontWeight.w600)),
                ]),
              ),
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(10, 0, 4, 8),
          child: Row(children: [
            Expanded(
              child: TextField(
                controller: _search,
                onChanged: store.search,
                style: const TextStyle(fontSize: 13, color: Cr.text),
                decoration: InputDecoration(
                  isDense: true,
                  hintText: 'Search',
                  prefixIcon: const Icon(Icons.search_rounded, size: 17),
                  // As tall as the Clear button's tap area, so the field doesn't jump when it appears.
                  prefixIconConstraints: const BoxConstraints(minWidth: 34, minHeight: 44),
                  suffixIcon: store.query.isEmpty
                      ? null
                      : IconButton(
                          tooltip: 'Clear',
                          iconSize: 16,
                          constraints: Cr.tapTarget,
                          visualDensity: VisualDensity.standard,
                          icon: const Icon(Icons.close_rounded),
                          onPressed: () {
                            _search.clear();
                            store.search('');
                          },
                        ),
                  suffixIconConstraints: Cr.tapTarget,
                  contentPadding: const EdgeInsets.symmetric(vertical: 9),
                ),
              ),
            ),
            IconButton(
              tooltip: 'Refresh',
              iconSize: 18,
              constraints: Cr.tapTarget,
              icon: const Icon(Icons.refresh_rounded),
              onPressed: store.loadingChats ? null : store.refreshChats,
            ),
          ]),
        ),
        if (!store.sidebarLive && store.chats.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 6),
            child: Text(liveOffNotice(store.liveOffReason, store.sidebarSavedAt),
                style: const TextStyle(color: Cr.textFaint, fontSize: 11.5)),
          ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: store.refreshChats,
            child: ListView.builder(
              padding: const EdgeInsets.only(bottom: 16),
              itemCount: entries.length,
              itemBuilder: (context, i) {
                final e = entries[i];
                return e is ChatRow ? _row(e) : e as Widget;
              },
              findChildIndexCallback: (key) {
                if (key is! ValueKey<String>) return null;
                final i = entries.indexWhere((e) => e is ChatRow && e.id == key.value);
                return i < 0 ? null : i;
              },
            ),
          ),
        ),
      ],
    );
  }

  Widget _row(ChatRow r) => ChatRowTile(
        key: ValueKey(r.id),
        row: r,
        selected: !store.draft && r.id == store.selectedChatId,
        running: r.id == store.liveComposer?.chatId && (store.liveComposer?.running ?? false),
        onTap: () => widget.onSelect(r),
        onAction: r.inSidebar ? (action) => _rowAction(r, action) : null,
      );

  /// Archive asks first: it takes the chat out of Cursor's sidebar.
  Future<void> _rowAction(ChatRow r, String action) async {
    if (action == 'archive') {
      final ok = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Archive this chat?'),
          content: Text('“${r.title}” moves to Archived in Cursor on the Mac.'),
          actions: [
            TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Archive')),
          ],
        ),
      );
      if (ok != true || !mounted) return;
    }
    await store.chatAction(r.id, action);
  }
}

class _SectionLabel extends StatelessWidget {
  final String text;
  const _SectionLabel(this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
      child: Text(text, style: const TextStyle(color: Cr.textFaint, fontSize: 11.5, fontWeight: FontWeight.w600)),
    );
  }
}

class _GroupHeader extends StatelessWidget {
  final String name;
  final int count;
  final bool collapsed;
  final bool waiting;
  final VoidCallback onTap;
  const _GroupHeader(
      {super.key,
      required this.name,
      required this.count,
      required this.collapsed,
      required this.waiting,
      required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 7, 14, 5),
        child: Row(children: [
          Icon(collapsed ? Icons.chevron_right_rounded : Icons.expand_more_rounded, size: 16, color: Cr.textFaint),
          const SizedBox(width: 4),
          const Icon(Icons.folder_outlined, size: 14, color: Cr.textSecondary),
          const SizedBox(width: 6),
          Expanded(
            child: Text(name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: Cr.textSecondary, fontSize: 12.5, fontWeight: FontWeight.w600)),
          ),
          if (collapsed && waiting) const _WaitingLabel(),
          if (collapsed && !waiting) Text('$count', style: const TextStyle(color: Cr.textFaint, fontSize: 11)),
        ]),
      ),
    );
  }
}

/// A sidebar chat row: status dot, title, time. Like Cursor, hovering shows Pin and Archive;
/// on touch screens a long press offers them.
class ChatRowTile extends StatefulWidget {
  final ChatRow row;
  final bool selected;
  final bool running;
  final VoidCallback onTap;

  /// 'pin', 'unpin' or 'archive'; null when the chat isn't in Cursor's sidebar.
  final ValueChanged<String>? onAction;
  const ChatRowTile(
      {super.key, required this.row, required this.selected, required this.onTap, this.running = false, this.onAction});

  @override
  State<ChatRowTile> createState() => _ChatRowTileState();
}

class _ChatRowTileState extends State<ChatRowTile> {
  bool _hover = false;

  Future<void> _menu(Offset at) async {
    final overlay = Overlay.of(context).context.findRenderObject() as RenderBox;
    final pinned = widget.row.pinned;
    final action = await showMenu<String>(
      context: context,
      position: RelativeRect.fromRect(at & const Size(1, 1), Offset.zero & overlay.size),
      items: [
        PopupMenuItem(value: pinned ? 'unpin' : 'pin', child: Text(pinned ? 'Unpin' : 'Pin')),
        const PopupMenuItem(value: 'archive', child: Text('Archive')),
      ],
    );
    if (action != null) widget.onAction?.call(action);
  }

  Widget _hoverButton(String tooltip, IconData icon, String action) => IconButton(
        tooltip: tooltip,
        iconSize: 15,
        padding: EdgeInsets.zero,
        visualDensity: VisualDensity.compact,
        constraints: const BoxConstraints.tightFor(width: 24, height: 20),
        color: Cr.textSecondary,
        icon: Icon(icon),
        onPressed: () => widget.onAction?.call(action),
      );

  @override
  Widget build(BuildContext context) {
    final row = widget.row;
    final selected = widget.selected;
    final isRunning = widget.running || row.running;
    final dot = row.waiting
        ? Cr.warning
        : row.status == 'error'
            ? Cr.danger
            : row.unread
                ? Cr.accent
                : null;
    final status = isRunning
        ? 'running'
        : row.waiting
            ? 'waiting for approval'
            : row.status == 'error'
                ? 'error'
                : 'idle';
    final actions = widget.onAction != null && _hover;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: MouseRegion(
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: GestureDetector(
          onLongPressStart: widget.onAction == null ? null : (d) => _menu(d.globalPosition),
          child: Material(
            color: selected ? Cr.surfaceHover : Colors.transparent,
            borderRadius: BorderRadius.circular(Cr.radiusSm),
            child: InkWell(
              borderRadius: BorderRadius.circular(Cr.radiusSm),
              onTap: widget.onTap,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
                child: Row(children: [
                  Semantics(
                    label: status,
                    child: SizedBox(
                      width: 14,
                      child: isRunning
                          ? const SizedBox(
                              width: 10,
                              height: 10,
                              child: CircularProgressIndicator(strokeWidth: 1.4, color: Cr.warning))
                          : dot == null
                              ? null
                              : Container(
                                  width: 7, height: 7, decoration: BoxDecoration(color: dot, shape: BoxShape.circle)),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(row.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                            color: selected || row.unread ? Cr.text : Cr.textSecondary,
                            fontSize: 13,
                            fontWeight: row.unread ? FontWeight.w600 : FontWeight.w400)),
                  ),
                  const SizedBox(width: 8),
                  if (actions) ...[
                    _hoverButton(row.pinned ? 'Unpin' : 'Pin', row.pinned ? Icons.push_pin : Icons.push_pin_outlined,
                        row.pinned ? 'unpin' : 'pin'),
                    _hoverButton('Archive', Icons.archive_outlined, 'archive'),
                  ] else if (row.waiting)
                    const _WaitingLabel()
                  else
                    Text(row.timeLabel(), style: const TextStyle(color: Cr.textFaint, fontSize: 11)),
                ]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Marks a chat, or a collapsed repository, that is waiting for approval.
class _WaitingLabel extends StatelessWidget {
  const _WaitingLabel();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(color: Cr.warning.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(999)),
      child: const Text('Approval', style: TextStyle(color: Cr.warning, fontSize: 10.5, fontWeight: FontWeight.w600)),
    );
  }
}
