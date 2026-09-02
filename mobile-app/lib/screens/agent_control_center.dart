import 'package:flutter/material.dart';
import '../models/cdp_models.dart';
import '../services/cdp_session_store.dart';
import '../theme/app_theme.dart';
import '../widgets/cr_ui.dart';
import 'agent_session_screen.dart';

/// Cursor-like Agents control center: sidebar + live session pane.
class AgentControlCenter extends StatefulWidget {
  final bool connected;
  final CdpSessionStore store;
  final VoidCallback onRefresh;
  final VoidCallback? onReconnect;
  final Future<void> Function(String type,
      {String? sessionId, String? text, String? requestId, String? historyId})
      sendCommand;

  const AgentControlCenter({
    super.key,
    required this.connected,
    required this.store,
    required this.onRefresh,
    required this.sendCommand,
    this.onReconnect,
  });

  @override
  State<AgentControlCenter> createState() => _AgentControlCenterState();
}

class _AgentControlCenterState extends State<AgentControlCenter> {
  String? _selectedSessionId;
  String? _selectedHistoryId;
  String _historyQuery = '';
  static const _wideBreakpoint = Cr.wideBreakpoint;
  static const _sidebarWidth = Cr.sidebarWidth;

  List<CdpSessionInfo> _sortedSessions() {
    final list = widget.store.sessions.values.map((e) => e.info).toList()
      ..sort((a, b) {
        int rank(String s) {
          switch (s.toUpperCase()) {
            case 'WAITING_FOR_PERMISSION':
              return 0;
            case 'RUNNING':
              return 1;
            case 'WAITING_FOR_INPUT':
              return 2;
            case 'ERROR':
              return 3;
            default:
              return 4;
          }
        }

        return rank(a.state).compareTo(rank(b.state));
      });
    return list;
  }

  void _selectSession(String id, {required bool pushOnNarrow, required bool wide}) {
    setState(() {
      _selectedSessionId = id;
      _selectedHistoryId = null;
    });
    widget.store.setFocusedSession(id);
    widget.sendCommand('select_session', sessionId: id);
    widget.sendCommand('get_agent_state', sessionId: id);
    if (!wide && pushOnNarrow) {
      Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => AgentSessionScreen(
            sessionId: id,
            store: widget.store,
            sendCommand: widget.sendCommand,
            onRefresh: widget.onRefresh,
          ),
        ),
      );
    }
  }

  void _openHistory(CdpHistoryItem item,
      {required bool pushOnNarrow, required bool wide}) {
    final sourceId = widget.store.historySourceSessionId;
    setState(() {
      _selectedHistoryId = item.id;
      if (sourceId != null) _selectedSessionId = sourceId;
    });
    widget.sendCommand('open_agent_history', historyId: item.id);
    if (sourceId != null) {
      widget.store.setFocusedSession(sourceId);
      widget.sendCommand('select_session', sessionId: sourceId);
      // Give Cursor UI a moment to switch, then pull conversation
      Future.delayed(const Duration(milliseconds: 900), () {
        widget.sendCommand('get_agent_state', sessionId: sourceId);
      });
      Future.delayed(const Duration(milliseconds: 1800), () {
        widget.sendCommand('get_agent_state', sessionId: sourceId);
      });
    }
    if (!wide && pushOnNarrow && sourceId != null) {
      Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => AgentSessionScreen(
            sessionId: sourceId,
            store: widget.store,
            sendCommand: widget.sendCommand,
            onRefresh: widget.onRefresh,
          ),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.store,
      builder: (context, _) {
        final list = _sortedSessions();
        final history = widget.store.history.where((h) {
          if (_historyQuery.trim().isEmpty) return true;
          final q = _historyQuery.toLowerCase();
          return h.title.toLowerCase().contains(q) ||
              h.group.toLowerCase().contains(q);
        }).toList();

        if (_selectedSessionId != null &&
            !widget.store.sessions.containsKey(_selectedSessionId)) {
          _selectedSessionId = list.isNotEmpty ? list.first.id : null;
        }
        if (_selectedSessionId == null && list.isNotEmpty) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (!mounted) return;
            if (_selectedSessionId == null && list.isNotEmpty) {
              final wide = MediaQuery.sizeOf(context).width >= _wideBreakpoint;
              if (wide) {
                _selectSession(list.first.id, pushOnNarrow: false, wide: true);
              }
            }
          });
        }

        final summary = widget.store.summary.working +
                    widget.store.summary.waiting +
                    widget.store.summary.idle +
                    widget.store.summary.error >
                0
            ? widget.store.summary
            : CdpStatusSummary.fromSessions(list);

        return LayoutBuilder(
          builder: (context, constraints) {
            final wide = constraints.maxWidth >= _wideBreakpoint;
            final sidebar = _AgentsSidebar(
              connected: widget.connected,
              cdpConnected: widget.store.cdpConnected,
              cdpError: widget.store.cdpError,
              summary: summary,
              sessions: list,
              history: history,
              historyQuery: _historyQuery,
              onHistoryQuery: (v) => setState(() => _historyQuery = v),
              store: widget.store,
              selectedId: _selectedSessionId,
              selectedHistoryId: _selectedHistoryId,
              onRefresh: widget.onRefresh,
              onReconnect: widget.onReconnect,
              onSelect: (id) =>
                  _selectSession(id, pushOnNarrow: true, wide: wide),
              onSelectHistory: (item) =>
                  _openHistory(item, pushOnNarrow: true, wide: wide),
            );

            if (!wide) {
              return ColoredBox(color: Cr.bg, child: sidebar);
            }

            return ColoredBox(
              color: Cr.bg,
              child: Row(
                children: [
                  SizedBox(
                    width: _sidebarWidth,
                    child: Material(color: Cr.bgElevated, child: sidebar),
                  ),
                  Container(width: 1, color: Cr.borderSubtle),
                  Expanded(
                    child: _selectedSessionId == null
                        ? const _WelcomePane()
                        : AgentSessionScreen(
                            key: ValueKey(
                                '$_selectedSessionId|$_selectedHistoryId'),
                            sessionId: _selectedSessionId!,
                            store: widget.store,
                            sendCommand: widget.sendCommand,
                            onRefresh: widget.onRefresh,
                            embedded: true,
                            historyTitle: history
                                .where((h) => h.id == _selectedHistoryId)
                                .map((h) => h.title)
                                .cast<String?>()
                                .firstOrNull,
                          ),
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }
}

extension _FirstOrNull<E> on Iterable<E> {
  E? get firstOrNull {
    final it = iterator;
    if (!it.moveNext()) return null;
    return it.current;
  }
}

class _AgentsSidebar extends StatelessWidget {
  final bool connected;
  final bool cdpConnected;
  final String? cdpError;
  final CdpStatusSummary summary;
  final List<CdpSessionInfo> sessions;
  final List<CdpHistoryItem> history;
  final String historyQuery;
  final ValueChanged<String> onHistoryQuery;
  final CdpSessionStore store;
  final String? selectedId;
  final String? selectedHistoryId;
  final VoidCallback onRefresh;
  final VoidCallback? onReconnect;
  final ValueChanged<String> onSelect;
  final ValueChanged<CdpHistoryItem> onSelectHistory;

  const _AgentsSidebar({
    required this.connected,
    required this.cdpConnected,
    required this.cdpError,
    required this.summary,
    required this.sessions,
    required this.history,
    required this.historyQuery,
    required this.onHistoryQuery,
    required this.store,
    required this.selectedId,
    required this.selectedHistoryId,
    required this.onRefresh,
    required this.onSelect,
    required this.onSelectHistory,
    this.onReconnect,
  });

  @override
  Widget build(BuildContext context) {
    final pinned = history.where((e) => e.isPinned).toList();
    final repos = history.where((e) => !e.isPinned).toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 10, 8),
          child: Row(
            children: [
              const Expanded(
                child: Text(
                  'Agents',
                  style: TextStyle(
                    color: Cr.text,
                    fontSize: 18,
                    fontWeight: FontWeight.w700,
                    letterSpacing: -0.3,
                  ),
                ),
              ),
              CrStatusChip(
                ok: connected && cdpConnected,
                label: !connected
                    ? 'Offline'
                    : (cdpConnected ? 'Live' : 'WS only'),
              ),
              IconButton(
                tooltip: 'Refresh',
                onPressed: onRefresh,
                icon: const Icon(Icons.refresh_rounded,
                    color: Cr.textSecondary, size: 20),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
          child: Text(
            '${sessions.length} live · ${history.length} history',
            style: const TextStyle(color: Cr.textSecondary, fontSize: 12),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
          child: TextField(
            onChanged: onHistoryQuery,
            style: const TextStyle(color: Cr.text, fontSize: 13),
            decoration: InputDecoration(
              hintText: 'Search agents…',
              hintStyle: const TextStyle(color: Cr.textFaint),
              isDense: true,
              filled: true,
              fillColor: Cr.surfaceHigh,
              prefixIcon: const Icon(Icons.search,
                  size: 18, color: Cr.textSecondary),
              contentPadding:
                  const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(Cr.radiusMd),
                borderSide: const BorderSide(color: Cr.borderSubtle),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(Cr.radiusMd),
                borderSide: const BorderSide(color: Cr.borderSubtle),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(Cr.radiusMd),
                borderSide: const BorderSide(color: Cr.accent),
              ),
            ),
          ),
        ),
        if (cdpError != null && !cdpConnected)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Text(cdpError!,
                style: const TextStyle(color: Cr.danger, fontSize: 11)),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          child: Row(
            children: [
              _StatChip(color: Cr.success, count: summary.working),
              const SizedBox(width: 6),
              _StatChip(color: Cr.warning, count: summary.waiting),
              const SizedBox(width: 6),
              _StatChip(color: Cr.textSecondary, count: summary.idle),
              const SizedBox(width: 6),
              _StatChip(color: Cr.danger, count: summary.error),
            ],
          ),
        ),
        const Divider(height: 1, color: Cr.borderSubtle),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.symmetric(vertical: 8),
            children: [
              const _SectionLabel('Live windows'),
              if (sessions.isEmpty)
                const _Hint('No live Cursor windows attached')
              else
                ...sessions.map((info) {
                  final view = store.sessions[info.id]!;
                  return _NavTile(
                    title: info.displayName,
                    subtitle: info.stateLabel,
                    preview: info.latestMessage ?? info.latestActivity,
                    selected:
                        info.id == selectedId && selectedHistoryId == null,
                    leading: _stateDot(info.state),
                    badge: info.unreadCount > 0 ? info.unreadCount : null,
                    warning: view.pendingApproval != null ||
                        info.hasPendingPermission,
                    onTap: () => onSelect(info.id),
                  );
                }),
              if (pinned.isNotEmpty) ...[
                const _SectionLabel('Pinned'),
                ...pinned.map((item) => _NavTile(
                      title: item.title,
                      subtitle: [
                        item.group,
                        if (item.relativeTime != null) item.relativeTime!,
                      ].join(' · '),
                      selected: item.id == selectedHistoryId,
                      leading: const Icon(Icons.push_pin_outlined,
                          size: 14, color: Color(0xFF8B8B8E)),
                      onTap: () => onSelectHistory(item),
                    )),
              ],
              if (repos.isNotEmpty) ...[
                _SectionLabel('History (${repos.length})'),
                ...repos.map((item) => _NavTile(
                      title: item.title,
                      subtitle: [
                        item.group,
                        if (item.relativeTime != null) item.relativeTime!,
                      ].join(' · '),
                      selected: item.id == selectedHistoryId,
                      leading: const Icon(Icons.history,
                          size: 14, color: Color(0xFF8B8B8E)),
                      onTap: () => onSelectHistory(item),
                    )),
              ] else if (history.isNotEmpty) ...[
                const _SectionLabel('History'),
                const _Hint('Scroll the Agents sidebar in Cursor, then refresh'),
              ],
              if (sessions.isEmpty && history.isEmpty)
                Padding(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    children: [
                      const Icon(Icons.desktop_windows_outlined,
                          size: 36, color: Color(0xFF5A5A5D)),
                      const SizedBox(height: 12),
                      const Text(
                        'No agents yet',
                        style: TextStyle(
                            color: Color(0xFFF2F2F3),
                            fontWeight: FontWeight.w600),
                      ),
                      const SizedBox(height: 6),
                      const Text(
                        'Open Cursor Agents on your Mac, then refresh.',
                        textAlign: TextAlign.center,
                        style:
                            TextStyle(color: Color(0xFF8B8B8E), fontSize: 12),
                      ),
                      const SizedBox(height: 14),
                      TextButton.icon(
                        onPressed: onRefresh,
                        icon: const Icon(Icons.refresh, size: 16),
                        label: const Text('Refresh'),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _stateDot(String state) {
    Color c;
    switch (state.toUpperCase()) {
      case 'RUNNING':
        c = const Color(0xFF4ADE80);
        break;
      case 'WAITING_FOR_PERMISSION':
      case 'WAITING_FOR_INPUT':
        c = const Color(0xFFFBBF24);
        break;
      case 'ERROR':
        c = const Color(0xFFF87171);
        break;
      default:
        c = const Color(0xFF9CA3AF);
    }
    return Container(
      width: 8,
      height: 8,
      decoration: BoxDecoration(color: c, shape: BoxShape.circle),
    );
  }
}

class _NavTile extends StatelessWidget {
  final String title;
  final String? subtitle;
  final String? preview;
  final bool selected;
  final Widget leading;
  final int? badge;
  final bool warning;
  final VoidCallback onTap;

  const _NavTile({
    required this.title,
    required this.leading,
    required this.selected,
    required this.onTap,
    this.subtitle,
    this.preview,
    this.badge,
    this.warning = false,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      child: Material(
        color: selected ? Cr.accentSoft : Colors.transparent,
        borderRadius: BorderRadius.circular(10),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(10),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 3),
                  child: leading,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: const Color(0xFFF2F2F3),
                          fontSize: 13,
                          fontWeight:
                              selected ? FontWeight.w600 : FontWeight.w500,
                        ),
                      ),
                      if (subtitle != null) ...[
                        const SizedBox(height: 2),
                        Text(
                          subtitle!,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                              color: Color(0xFF8B8B8E), fontSize: 11),
                        ),
                      ],
                      if (preview != null && preview!.isNotEmpty) ...[
                        const SizedBox(height: 3),
                        Text(
                          preview!,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                              color: Color(0xFF6B6B6E), fontSize: 11),
                        ),
                      ],
                    ],
                  ),
                ),
                if (warning)
                  const Padding(
                    padding: EdgeInsets.only(left: 4),
                    child: Icon(Icons.warning_amber_rounded,
                        size: 14, color: Color(0xFFFBBF24)),
                  ),
                if (badge != null)
                  Container(
                    margin: const EdgeInsets.only(left: 6),
                    padding:
                        const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(
                      color: Cr.accent,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(
                      '$badge',
                      style: const TextStyle(
                          color: Colors.white,
                          fontSize: 10,
                          fontWeight: FontWeight.w700),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  final String text;
  const _SectionLabel(this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 6),
      child: Text(
        text.toUpperCase(),
        style: const TextStyle(
          color: Color(0xFF6B6B6E),
          fontSize: 10,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.8,
        ),
      ),
    );
  }
}

class _Hint extends StatelessWidget {
  final String text;
  const _Hint(this.text);
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
      child: Text(text,
          style: const TextStyle(color: Color(0xFF6B6B6E), fontSize: 12)),
    );
  }
}

class _StatChip extends StatelessWidget {
  final Color color;
  final int count;
  const _StatChip({required this.color, required this.count});
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: const Color(0xFF1A1A1B),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: const Color(0xFF2A2A2C)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 5),
          Text('$count',
              style: const TextStyle(color: Color(0xFFD0D0D2), fontSize: 11)),
        ],
      ),
    );
  }
}

class _WelcomePane extends StatelessWidget {
  const _WelcomePane();

  @override
  Widget build(BuildContext context) {
    return const ColoredBox(
      color: Cr.bg,
      child: Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.forum_outlined, size: 48, color: Cr.textFaint),
              SizedBox(height: 16),
              Text(
                'Select an agent',
                style: TextStyle(
                  color: Cr.text,
                  fontSize: 18,
                  fontWeight: FontWeight.w600,
                  letterSpacing: -0.2,
                ),
              ),
              SizedBox(height: 8),
              Text(
                'Pick a live window or history item from the sidebar\nto read and control that Cursor session.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Cr.textSecondary, height: 1.45),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
