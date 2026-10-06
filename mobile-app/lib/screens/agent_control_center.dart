import 'package:flutter/material.dart';

import '../models/chat_models.dart';
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

  @override
  Widget build(BuildContext context) {
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
        return Row(children: [
          SizedBox(width: Cr.sidebarWidth, child: Material(color: Cr.bgElevated, child: sidebar)),
          Container(width: 1, color: Cr.borderSubtle),
          Expanded(child: AgentChatPane(store: store)),
        ]);
      }
      return ListenableBuilder(
        listenable: store,
        builder: (context, _) {
          final picked = store.draft || store.selectedChatId != null;
          return Scaffold(
            key: _scaffold,
            backgroundColor: Cr.bg,
            drawer: Drawer(
              width: Cr.sidebarWidth,
              backgroundColor: Cr.bgElevated,
              shape: const RoundedRectangleBorder(),
              child: SafeArea(child: sidebar),
            ),
            body: picked
                ? AgentChatPane(store: store, onOpenSidebar: () => _scaffold.currentState?.openDrawer())
                : Material(color: Cr.bgElevated, child: sidebar),
          );
        },
      );
    });
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

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) {
        final sections = store.sections;
        final pinned = sections.where((s) => s.pinned).toList();
        final repos = sections.where((s) => !s.pinned).toList();
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
                      Expanded(
                        child: Text('New Chat',
                            style: TextStyle(color: Cr.text, fontSize: 13.5, fontWeight: FontWeight.w600)),
                      ),
                      Text('⌘N', style: TextStyle(color: Cr.textFaint, fontSize: 11.5)),
                    ]),
                  ),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 0, 10, 8),
              child: TextField(
                controller: _search,
                onChanged: store.search,
                style: const TextStyle(fontSize: 13, color: Cr.text),
                decoration: InputDecoration(
                  isDense: true,
                  hintText: 'Search',
                  prefixIcon: const Icon(Icons.search_rounded, size: 17),
                  prefixIconConstraints: const BoxConstraints(minWidth: 34),
                  suffixIcon: store.query.isEmpty
                      ? null
                      : IconButton(
                          tooltip: 'Clear',
                          iconSize: 16,
                          icon: const Icon(Icons.close_rounded),
                          onPressed: () {
                            _search.clear();
                            store.search('');
                          },
                        ),
                  contentPadding: const EdgeInsets.symmetric(vertical: 9),
                ),
              ),
            ),
            if (!store.sidebarLive && store.chats.isNotEmpty)
              const Padding(
                padding: EdgeInsets.fromLTRB(14, 0, 14, 6),
                child: Text('Agents window not attached — showing chats saved on the Mac.',
                    style: TextStyle(color: Cr.textFaint, fontSize: 11.5)),
              ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: store.refreshChats,
                child: ListView(
                  padding: const EdgeInsets.only(bottom: 16),
                  children: [
                    if (store.chats.isEmpty)
                      Padding(
                        padding: const EdgeInsets.all(24),
                        child: Center(
                          child: store.loadingChats
                              ? const CircularProgressIndicator(strokeWidth: 2)
                              : const Text('No chats yet.', style: TextStyle(color: Cr.textSecondary)),
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
                      for (final r in s.rows) _row(r),
                    ],
                    if (repos.isNotEmpty) const _SectionLabel('Repositories'),
                    for (final s in repos) ...[
                      _GroupHeader(
                        name: s.name,
                        count: s.rows.length,
                        collapsed: _collapsed.contains(s.name),
                        onTap: () => setState(() =>
                            _collapsed.contains(s.name) ? _collapsed.remove(s.name) : _collapsed.add(s.name)),
                      ),
                      if (!_collapsed.contains(s.name))
                        for (final r in s.rows) _row(r),
                    ],
                    if (store.hasMoreChats)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(10, 6, 10, 0),
                        child: TextButton(
                          onPressed: store.loadingChats ? null : store.loadMoreChats,
                          child: Text(store.loadingChats ? 'Loading…' : 'More'),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ],
        );
      },
    );
  }

  Widget _row(ChatRow r) => ChatRowTile(
        row: r,
        selected: !store.draft && r.id == store.selectedChatId,
        running: r.id == store.liveComposer?.chatId && (store.liveComposer?.running ?? false),
        onTap: () => widget.onSelect(r),
      );
}

class _SectionLabel extends StatelessWidget {
  final String text;
  const _SectionLabel(this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
      child: Text(text,
          style: const TextStyle(color: Cr.textFaint, fontSize: 11.5, fontWeight: FontWeight.w600)),
    );
  }
}

class _GroupHeader extends StatelessWidget {
  final String name;
  final int count;
  final bool collapsed;
  final VoidCallback onTap;
  const _GroupHeader({required this.name, required this.count, required this.collapsed, required this.onTap});

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
          if (collapsed) Text('$count', style: const TextStyle(color: Cr.textFaint, fontSize: 11)),
        ]),
      ),
    );
  }
}

/// A sidebar chat row: status dot, title, time.
class ChatRowTile extends StatelessWidget {
  final ChatRow row;
  final bool selected;
  final bool running;
  final VoidCallback onTap;
  const ChatRowTile({super.key, required this.row, required this.selected, required this.onTap, this.running = false});

  @override
  Widget build(BuildContext context) {
    final isRunning = running || row.running;
    final dot = row.waiting
        ? Cr.warning
        : row.status == 'error'
            ? Cr.danger
            : row.unread
                ? Cr.accent
                : null;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Material(
        color: selected ? Cr.surfaceHover : Colors.transparent,
        borderRadius: BorderRadius.circular(Cr.radiusSm),
        child: InkWell(
          borderRadius: BorderRadius.circular(Cr.radiusSm),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
            child: Row(children: [
              SizedBox(
                width: 14,
                child: isRunning
                    ? const SizedBox(
                        width: 10, height: 10, child: CircularProgressIndicator(strokeWidth: 1.4, color: Cr.warning))
                    : dot == null
                        ? null
                        : Container(
                            width: 7, height: 7, decoration: BoxDecoration(color: dot, shape: BoxShape.circle)),
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
              Text(row.timeLabel(), style: const TextStyle(color: Cr.textFaint, fontSize: 11)),
            ]),
          ),
        ),
      ),
    );
  }
}
