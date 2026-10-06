import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import '../models/cdp_models.dart';
import '../services/cdp_session_store.dart';
import '../theme/app_theme.dart';

/// Cursor Agents–aligned chat tokens (shared [Cr] system).
class _CursorChatTheme {
  static const bg = Cr.bg;
  static const panel = Cr.bgElevated;
  static const userBubble = Cr.userBubble;
  static const text = Cr.text;
  static const muted = Cr.textSecondary;
  static const faint = Cr.textFaint;
  static const link = Cr.link;
  static const border = Cr.border;
  static const accent = Cr.accent;
}

/// Session detail: Chat / Plan / Changes / Activity for one EXISTING Cursor Agent.
class AgentSessionScreen extends StatefulWidget {
  final String sessionId;
  final CdpSessionStore store;
  final Future<void> Function(String type,
      {String? sessionId, String? text, String? requestId, String? historyId})
      sendCommand;
  final VoidCallback onRefresh;
  /// When true, render as an embedded pane (no route AppBar back button).
  final bool embedded;
  /// Optional history row title when opened from Agents sidebar.
  final String? historyTitle;

  const AgentSessionScreen({
    super.key,
    required this.sessionId,
    required this.store,
    required this.sendCommand,
    required this.onRefresh,
    this.embedded = false,
    this.historyTitle,
  });

  @override
  State<AgentSessionScreen> createState() => _AgentSessionScreenState();
}

class _AgentSessionScreenState extends State<AgentSessionScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabs;
  final _input = TextEditingController();
  final _scroll = ScrollController();
  bool _sending = false;

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 4, vsync: this);
    widget.store.setFocusedSession(widget.sessionId);
    widget.sendCommand('select_session', sessionId: widget.sessionId);
    widget.sendCommand('get_agent_state', sessionId: widget.sessionId);
  }

  @override
  void dispose() {
    if (widget.store.focusedSessionId == widget.sessionId) {
      widget.store.setFocusedSession(null);
    }
    _tabs.dispose();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      await widget.sendCommand(
        'agent_prompt',
        sessionId: widget.sessionId,
        text: text,
      );
      _input.clear();
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.store,
      builder: (context, _) {
        final view = widget.store.sessions[widget.sessionId];
        if (view == null) {
          return Scaffold(
            backgroundColor: const Color(0xFF1E1E1E),
            appBar: AppBar(
              backgroundColor: const Color(0xFF252526),
              title: const Text('Session'),
            ),
            body: const Center(
              child: Text('Session no longer available',
                  style: TextStyle(color: Colors.white70)),
            ),
          );
        }

        final info = view.info;
        final pending = view.pendingApproval;

        final body = Column(
          children: [
            if (pending != null)
              _PermissionBanner(request: pending),
            Expanded(
              child: TabBarView(
                controller: _tabs,
                children: [
                  _ChatTab(
                    messages: view.messages,
                    notes: view.extractionNotes,
                    controller: _scroll,
                    agentRunning: info.state.toUpperCase() == 'RUNNING',
                  ),
                  _PlanTab(plan: view.plan),
                  _ChangesTab(changes: view.fileChanges),
                  _ActivityTab(activity: view.activity),
                ],
              ),
            ),
            _Composer(
              controller: _input,
              sending: _sending,
              onSend: _send,
            ),
          ],
        );

        if (widget.embedded) {
          return ColoredBox(
            color: _CursorChatTheme.bg,
            child: Column(
              children: [
                Material(
                  color: _CursorChatTheme.panel,
                  child: Column(
                    children: [
                      Padding(
                        padding: const EdgeInsets.fromLTRB(20, 14, 8, 0),
                        child: Row(
                          children: [
                            Expanded(
                              child: Text(
                                widget.historyTitle?.isNotEmpty == true
                                    ? widget.historyTitle!
                                    : info.displayName,
                                style: const TextStyle(
                                  color: _CursorChatTheme.text,
                                  fontSize: 15,
                                  fontWeight: FontWeight.w600,
                                  letterSpacing: -0.2,
                                ),
                              ),
                            ),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 8, vertical: 3),
                              decoration: BoxDecoration(
                                color: const Color(0xFF1A2332),
                                borderRadius: BorderRadius.circular(999),
                                border: Border.all(
                                    color: const Color(0xFF2B4A6F)),
                              ),
                              child: const Text(
                                'IDE',
                                style: TextStyle(
                                  color: Color(0xFF7EB6E8),
                                  fontSize: 10,
                                  fontWeight: FontWeight.w600,
                                  letterSpacing: 0.4,
                                ),
                              ),
                            ),
                            IconButton(
                              tooltip: 'Refresh',
                              onPressed: () {
                                widget.onRefresh();
                                widget.sendCommand('get_agent_state',
                                    sessionId: widget.sessionId);
                              },
                              icon: const Icon(Icons.refresh_rounded,
                                  color: _CursorChatTheme.muted, size: 20),
                            ),
                          ],
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(20, 4, 20, 0),
                        child: Align(
                          alignment: Alignment.centerLeft,
                          child: Text(
                            [
                              info.stateLabel,
                              if (info.model != null && info.model!.isNotEmpty)
                                info.model!,
                              if (info.workspace != null &&
                                  info.workspace!.isNotEmpty &&
                                  info.workspace != info.displayName)
                                info.workspace!,
                            ].join(' · '),
                            style: const TextStyle(
                              fontSize: 11,
                              color: _CursorChatTheme.muted,
                            ),
                          ),
                        ),
                      ),
                      TabBar(
                        controller: _tabs,
                        indicatorColor: const Color(0xFF4ADE80),
                        indicatorSize: TabBarIndicatorSize.label,
                        labelColor: _CursorChatTheme.text,
                        unselectedLabelColor: _CursorChatTheme.muted,
                        labelStyle: const TextStyle(
                            fontSize: 13, fontWeight: FontWeight.w600),
                        tabs: const [
                          Tab(text: 'Chat'),
                          Tab(text: 'Plan'),
                          Tab(text: 'Changes'),
                          Tab(text: 'Activity'),
                        ],
                      ),
                    ],
                  ),
                ),
                Expanded(child: body),
              ],
            ),
          );
        }

        return Scaffold(
          backgroundColor: const Color(0xFF1E1E1E),
          appBar: AppBar(
            backgroundColor: const Color(0xFF252526),
            foregroundColor: Colors.white,
            title: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(info.displayName,
                    style: const TextStyle(
                        fontSize: 16, fontWeight: FontWeight.w700)),
                Text(
                  '${emojiForAgentState(info.state)} ${info.stateLabel}',
                  style:
                      const TextStyle(fontSize: 12, color: Color(0xFFBDBDBD)),
                ),
              ],
            ),
            actions: [
              IconButton(
                onPressed: () {
                  widget.onRefresh();
                  widget.sendCommand('get_agent_state',
                      sessionId: widget.sessionId);
                },
                icon: const Icon(Icons.refresh),
              ),
            ],
            bottom: TabBar(
              controller: _tabs,
              indicatorColor: const Color(0xFF80CBC4),
              labelColor: Colors.white,
              unselectedLabelColor: const Color(0xFF9E9E9E),
              tabs: const [
                Tab(text: 'Chat'),
                Tab(text: 'Plan'),
                Tab(text: 'Changes'),
                Tab(text: 'Activity'),
              ],
            ),
          ),
          body: body,
        );
      },
    );
  }
}

class _PermissionBanner extends StatelessWidget {
  final CdpPermissionRequest request;

  const _PermissionBanner({required this.request});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: const Color(0xFF3E2723),
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text(
                '⚠️ Permission Required',
                style: TextStyle(
                  color: Color(0xFFFFCC80),
                  fontWeight: FontWeight.w800,
                  fontSize: 15,
                ),
              ),
              const SizedBox(height: 6),
              const Text(
                'Agent wants to execute:',
                style: TextStyle(color: Colors.white70, fontSize: 13),
              ),
              const SizedBox(height: 4),
              Text(
                request.detail,
                style: const TextStyle(
                  color: Colors.white,
                  fontFamily: 'monospace',
                  fontSize: 13,
                ),
              ),
              const SizedBox(height: 12),
              const Text(
                'Approve or reject it in Cursor on your computer — '
                'remote approval is disabled for safety.',
                style: TextStyle(color: Color(0xFFFFCC80), fontSize: 13),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  final TextEditingController controller;
  final bool sending;
  final VoidCallback onSend;

  const _Composer({
    required this.controller,
    required this.sending,
    required this.onSend,
  });

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Container(
        color: _CursorChatTheme.bg,
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              decoration: BoxDecoration(
                color: const Color(0xFF1A1C22),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: _CursorChatTheme.border),
              ),
              padding: const EdgeInsets.fromLTRB(6, 4, 6, 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  IconButton(
                    onPressed: null,
                    tooltip: 'Attach',
                    icon: const Icon(Icons.add, color: _CursorChatTheme.faint),
                    visualDensity: VisualDensity.compact,
                  ),
                  Expanded(
                    child: TextField(
                      controller: controller,
                      style: const TextStyle(
                        color: _CursorChatTheme.text,
                        fontSize: 14,
                        height: 1.4,
                      ),
                      minLines: 1,
                      maxLines: 6,
                      decoration: const InputDecoration(
                        hintText: 'Send a follow-up…',
                        hintStyle: TextStyle(color: _CursorChatTheme.faint),
                        border: InputBorder.none,
                        isDense: true,
                        contentPadding:
                            EdgeInsets.symmetric(horizontal: 4, vertical: 12),
                      ),
                      textInputAction: TextInputAction.send,
                      onSubmitted: (_) => onSend(),
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.only(bottom: 4, right: 4),
                    child: Material(
                      color: sending
                          ? _CursorChatTheme.border
                          : _CursorChatTheme.accent,
                      shape: const CircleBorder(),
                      child: InkWell(
                        customBorder: const CircleBorder(),
                        onTap: sending ? null : onSend,
                        child: SizedBox(
                          width: 34,
                          height: 34,
                          child: Center(
                            child: sending
                                ? const SizedBox(
                                    width: 14,
                                    height: 14,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                      color: Colors.white70,
                                    ),
                                  )
                                : const Icon(Icons.arrow_upward_rounded,
                                    size: 18, color: Colors.white),
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 6),
            const Row(
              children: [
                Text(
                  'This Mac',
                  style: TextStyle(
                      color: _CursorChatTheme.faint, fontSize: 11),
                ),
                Icon(Icons.expand_more,
                    size: 14, color: _CursorChatTheme.faint),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _ChatTab extends StatefulWidget {
  final List<CdpAgentMessage> messages;
  final List<String> notes;
  final ScrollController controller;
  final bool agentRunning;

  const _ChatTab({
    required this.messages,
    required this.notes,
    required this.controller,
    this.agentRunning = false,
  });

  @override
  State<_ChatTab> createState() => _ChatTabState();
}

class _ChatTabState extends State<_ChatTab> {
  int _lastCount = 0;
  int _pendingNew = 0;
  bool _stickToBottom = true;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onScroll);
    _lastCount = widget.messages.length;
  }

  @override
  void didUpdateWidget(covariant _ChatTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.messages.length != _lastCount ||
        (widget.messages.isNotEmpty &&
            oldWidget.messages.isNotEmpty &&
            widget.messages.last.text != oldWidget.messages.last.text)) {
      final grew = widget.messages.length > _lastCount;
      _lastCount = widget.messages.length;
      if (_stickToBottom) {
        WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToEnd());
      } else if (grew) {
        setState(() => _pendingNew++);
      }
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onScroll);
    super.dispose();
  }

  void _onScroll() {
    if (!widget.controller.hasClients) return;
    final pos = widget.controller.position;
    final atBottom = pos.pixels >= pos.maxScrollExtent - 80;
    if (atBottom != _stickToBottom) {
      setState(() {
        _stickToBottom = atBottom;
        if (atBottom) _pendingNew = 0;
      });
    }
  }

  void _scrollToEnd() {
    if (!widget.controller.hasClients) return;
    widget.controller.animateTo(
      widget.controller.position.maxScrollExtent,
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOut,
    );
    setState(() => _pendingNew = 0);
  }

  bool _isMetaLine(CdpAgentMessage m) {
    if (m.role != 'tool' && m.role != 'system') return false;
    final t = m.text.trim();
    return RegExp(r'^(worked for|thought)\b', caseSensitive: false).hasMatch(t) ||
        RegExp(r'^chat context summarized$', caseSensitive: false).hasMatch(t);
  }

  @override
  Widget build(BuildContext context) {
    if (widget.messages.isEmpty) {
      return ListView(
        padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 48),
        children: [
          const Icon(Icons.chat_bubble_outline,
              size: 40, color: Color(0xFF4B4B4E)),
          const SizedBox(height: 16),
          const Text(
            'Conversation will appear here',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: _CursorChatTheme.text,
              fontSize: 16,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            widget.agentRunning
                ? 'Agent is working in Cursor — new messages sync as they appear.'
                : 'Open this chat in Cursor Agents, or send a prompt below.\nHistory rows load best-effort from the Agents sidebar.',
            textAlign: TextAlign.center,
            style: const TextStyle(
                color: _CursorChatTheme.muted, fontSize: 13, height: 1.45),
          ),
          if (widget.notes.isNotEmpty) ...[
            const SizedBox(height: 24),
            Theme(
              data: ThemeData.dark(),
              child: ExpansionTile(
                tilePadding: EdgeInsets.zero,
                title: const Text(
                  'Diagnostics',
                  style: TextStyle(color: _CursorChatTheme.muted, fontSize: 12),
                ),
                children: widget.notes
                    .map((n) => Align(
                          alignment: Alignment.centerLeft,
                          child: Padding(
                            padding: const EdgeInsets.only(bottom: 4),
                            child: Text('• $n',
                                style: const TextStyle(
                                    color: _CursorChatTheme.faint,
                                    fontSize: 11)),
                          ),
                        ))
                    .toList(),
              ),
            ),
          ],
        ],
      );
    }

    return ColoredBox(
      color: _CursorChatTheme.bg,
      child: Stack(
        children: [
          ListView.builder(
            controller: widget.controller,
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 32),
            itemCount: widget.messages.length + (widget.agentRunning ? 1 : 0),
            itemBuilder: (context, i) {
              if (i == widget.messages.length) {
                return const Padding(
                  padding: EdgeInsets.only(top: 8, bottom: 8),
                  child: Row(
                    children: [
                      SizedBox(
                        width: 12,
                        height: 12,
                        child: CircularProgressIndicator(
                          strokeWidth: 1.5,
                          color: _CursorChatTheme.muted,
                        ),
                      ),
                      SizedBox(width: 10),
                      Text(
                        'Working…',
                        style: TextStyle(
                            color: _CursorChatTheme.muted, fontSize: 12),
                      ),
                    ],
                  ),
                );
              }
              final m = widget.messages[i];
              if (_isMetaLine(m)) {
                return Padding(
                  padding: const EdgeInsets.only(bottom: 10, top: 4),
                  child: Text(
                    m.text.trim(),
                    style: const TextStyle(
                      color: _CursorChatTheme.muted,
                      fontSize: 12,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                );
              }
              if (m.role == 'user') {
                return _CursorUserBubble(text: m.text);
              }
              return _CursorAssistantBlock(
                text: m.text,
                streaming: m.status == 'streaming',
              );
            },
          ),
          if (_pendingNew > 0)
            Positioned(
              bottom: 12,
              left: 0,
              right: 0,
              child: Center(
                child: Material(
                  color: _CursorChatTheme.accent,
                  borderRadius: BorderRadius.circular(20),
                  child: InkWell(
                    onTap: _scrollToEnd,
                    borderRadius: BorderRadius.circular(20),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 14, vertical: 8),
                      child: Text(
                        '$_pendingNew new message${_pendingNew == 1 ? '' : 's'} ↓',
                        style: const TextStyle(
                            color: Colors.white,
                            fontSize: 12,
                            fontWeight: FontWeight.w600),
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _CursorUserBubble extends StatelessWidget {
  final String text;
  const _CursorUserBubble({required this.text});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: ConstrainedBox(
              constraints: BoxConstraints(
                maxWidth: MediaQuery.sizeOf(context).width * 0.92,
              ),
              child: Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                decoration: BoxDecoration(
                  color: _CursorChatTheme.userBubble,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: SelectableText(
                  text,
                  style: const TextStyle(
                    color: _CursorChatTheme.text,
                    fontSize: 14.5,
                    height: 1.45,
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 6),
          _MessageActions(text: text),
        ],
      ),
    );
  }
}

class _CursorAssistantBlock extends StatelessWidget {
  final String text;
  final bool streaming;
  const _CursorAssistantBlock({required this.text, this.streaming = false});

  static MarkdownStyleSheet _sheet(BuildContext context) {
    const base = TextStyle(
      color: _CursorChatTheme.text,
      fontSize: 14.5,
      height: 1.55,
    );
    return MarkdownStyleSheet(
      p: base,
      pPadding: const EdgeInsets.only(bottom: 10),
      strong: base.copyWith(fontWeight: FontWeight.w700),
      em: base.copyWith(fontStyle: FontStyle.italic),
      a: base.copyWith(
        color: _CursorChatTheme.link,
        decoration: TextDecoration.underline,
        decorationColor: _CursorChatTheme.link.withValues(alpha: 0.4),
      ),
      code: base.copyWith(
        fontFamily: 'monospace',
        fontSize: 13,
        backgroundColor: const Color(0xFF1A1C22),
        color: const Color(0xFFE2E8F0),
      ),
      codeblockDecoration: BoxDecoration(
        color: const Color(0xFF1A1C22),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: _CursorChatTheme.border),
      ),
      codeblockPadding: const EdgeInsets.all(12),
      blockquote: base.copyWith(color: _CursorChatTheme.muted),
      blockquoteDecoration: const BoxDecoration(
        border: Border(
          left: BorderSide(color: _CursorChatTheme.border, width: 3),
        ),
      ),
      h1: base.copyWith(fontSize: 20, fontWeight: FontWeight.w700, height: 1.3),
      h2: base.copyWith(fontSize: 17, fontWeight: FontWeight.w700, height: 1.3),
      h3: base.copyWith(fontSize: 15, fontWeight: FontWeight.w700, height: 1.3),
      h1Padding: const EdgeInsets.only(top: 8, bottom: 8),
      h2Padding: const EdgeInsets.only(top: 6, bottom: 6),
      h3Padding: const EdgeInsets.only(top: 4, bottom: 4),
      listBullet: base,
      listIndent: 22,
      tableHead: base.copyWith(
        fontWeight: FontWeight.w600,
        color: _CursorChatTheme.muted,
        fontSize: 13,
      ),
      tableBody: base.copyWith(fontSize: 13.5),
      tableBorder: TableBorder(
        horizontalInside: BorderSide(
          color: _CursorChatTheme.border.withValues(alpha: 0.9),
        ),
        bottom: BorderSide(color: _CursorChatTheme.border.withValues(alpha: 0.9)),
      ),
      tableCellsPadding:
          const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      tableHeadAlign: TextAlign.left,
      tableColumnWidth: const FlexColumnWidth(),
      horizontalRuleDecoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: _CursorChatTheme.border.withValues(alpha: 0.8)),
        ),
      ),
    );
  }

  /// Soften plain DOM text into markdown-ish structure when Cursor dumps
  /// headings without `#` markers (common from DOM scrape).
  String _prepare(String raw) {
    var t = raw.trim();
    // Linkify bare cursor.com / http URLs that aren't already markdown links
    t = t.replaceAllMapped(
      RegExp(r'(?<!\]\()(?<!\[)(https?:\/\/[^\s\)]+|cursor\.com\/[^\s\)]+)'),
      (m) {
        final u = m.group(1)!;
        final href = u.startsWith('http') ? u : 'https://$u';
        return '[$u]($href)';
      },
    );
    return t;
  }

  @override
  Widget build(BuildContext context) {
    final prepared = _prepare(text);
    return Padding(
      padding: const EdgeInsets.only(bottom: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (streaming)
            const Padding(
              padding: EdgeInsets.only(bottom: 6),
              child: Text(
                'Generating…',
                style: TextStyle(
                    color: _CursorChatTheme.muted,
                    fontSize: 11,
                    fontWeight: FontWeight.w500),
              ),
            ),
          MarkdownBody(
            data: prepared,
            selectable: true,
            styleSheet: _sheet(context),
            softLineBreak: true,
          ),
          const SizedBox(height: 8),
          _MessageActions(text: text),
        ],
      ),
    );
  }
}

class _MessageActions extends StatelessWidget {
  final String text;
  const _MessageActions({required this.text});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        _ActionIcon(
          icon: Icons.thumb_up_alt_outlined,
          onTap: () {},
        ),
        _ActionIcon(
          icon: Icons.thumb_down_alt_outlined,
          onTap: () {},
        ),
        _ActionIcon(
          icon: Icons.content_copy_rounded,
          onTap: () async {
            await Clipboard.setData(ClipboardData(text: text));
            if (context.mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(
                  content: Text('Copied'),
                  duration: Duration(seconds: 1),
                  behavior: SnackBarBehavior.floating,
                ),
              );
            }
          },
        ),
        _ActionIcon(
          icon: Icons.refresh_rounded,
          onTap: () {},
        ),
      ],
    );
  }
}

class _ActionIcon extends StatelessWidget {
  final IconData icon;
  final VoidCallback onTap;
  const _ActionIcon({required this.icon, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Padding(
        padding: const EdgeInsets.all(6),
        child: Icon(icon, size: 15, color: _CursorChatTheme.faint),
      ),
    );
  }
}

class _PlanTab extends StatelessWidget {
  final CdpAgentPlan? plan;
  const _PlanTab({required this.plan});

  @override
  Widget build(BuildContext context) {
    if (plan == null || !plan!.available) {
      return const Padding(
        padding: EdgeInsets.all(16),
        child: Text(
          'Plan\n\nNOT CURRENTLY ACCESSIBLE / PARTIALLY SUPPORTED\n\n'
          'No plan UI detected in this Cursor target. '
          'When Cursor exposes plan steps in the DOM, they appear here.',
          style: TextStyle(color: Colors.white70, height: 1.4),
        ),
      );
    }
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(
          plan!.title.isEmpty ? 'Plan' : plan!.title,
          style: const TextStyle(
              color: Colors.white, fontSize: 18, fontWeight: FontWeight.w700),
        ),
        Text('Support: ${plan!.support}',
            style: const TextStyle(color: Color(0xFF9E9E9E), fontSize: 12)),
        const SizedBox(height: 12),
        ...plan!.steps.map((s) {
          final mark = s.status == 'completed'
              ? '✓'
              : s.status == 'running'
                  ? '●'
                  : '○';
          return Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(mark,
                    style: TextStyle(
                      color: s.status == 'completed'
                          ? const Color(0xFF81C784)
                          : s.status == 'running'
                              ? const Color(0xFFFFB74D)
                              : const Color(0xFF9E9E9E),
                      fontSize: 16,
                    )),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(s.text,
                      style: const TextStyle(color: Colors.white, fontSize: 14)),
                ),
              ],
            ),
          );
        }),
      ],
    );
  }
}

class _ChangesTab extends StatelessWidget {
  final CdpFileChanges changes;
  const _ChangesTab({required this.changes});

  @override
  Widget build(BuildContext context) {
    if (!changes.available) {
      return Padding(
        padding: const EdgeInsets.all(16),
        child: Text(
          'Changes\n\n${changes.support}\n\n'
          '${changes.note ?? "File change list is not reliably exposed via CDP Agent DOM."}\n'
          'Diffs are typically NOT CURRENTLY ACCESSIBLE from this path.',
          style: const TextStyle(color: Colors.white70, height: 1.4),
        ),
      );
    }
    final modified =
        changes.items.where((e) => e.changeType == 'modified').toList();
    final added = changes.items.where((e) => e.changeType == 'added').toList();
    final deleted =
        changes.items.where((e) => e.changeType == 'deleted').toList();
    final other =
        changes.items.where((e) => e.changeType == 'unknown').toList();

    Widget section(String title, List<CdpFileChange> items, Color color) {
      if (items.isEmpty) return const SizedBox.shrink();
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title,
              style: TextStyle(
                  color: color, fontWeight: FontWeight.w700, fontSize: 14)),
          const SizedBox(height: 6),
          ...items.map((f) => Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Text(f.path,
                    style: const TextStyle(
                        color: Colors.white, fontFamily: 'monospace')),
              )),
          const SizedBox(height: 14),
        ],
      );
    }

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text('Support: ${changes.support}',
            style: const TextStyle(color: Color(0xFF9E9E9E), fontSize: 12)),
        const SizedBox(height: 12),
        section('Modified', modified, const Color(0xFFFFB74D)),
        section('Added', added, const Color(0xFF81C784)),
        section('Deleted', deleted, const Color(0xFFE57373)),
        section('Other', other, const Color(0xFFBDBDBD)),
      ],
    );
  }
}

class _ActivityTab extends StatelessWidget {
  final List<CdpActivityEvent> activity;
  const _ActivityTab({required this.activity});

  @override
  Widget build(BuildContext context) {
    if (activity.isEmpty) {
      return const Padding(
        padding: EdgeInsets.all(16),
        child: Text(
          'No activity events yet.\nUpdates appear as the Agent works.',
          style: TextStyle(color: Colors.white70),
        ),
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.all(16),
      itemCount: activity.length,
      separatorBuilder: (_, __) => const Divider(color: Color(0xFF333333)),
      itemBuilder: (context, i) {
        final e = activity[activity.length - 1 - i];
        return ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(_icon(e.kind), color: const Color(0xFF80CBC4), size: 20),
          title: Text(e.text,
              style: const TextStyle(color: Colors.white, fontSize: 14)),
          subtitle: Text(e.kind,
              style: const TextStyle(color: Color(0xFF9E9E9E), fontSize: 11)),
        );
      },
    );
  }

  IconData _icon(String kind) {
    switch (kind) {
      case 'reading':
        return Icons.menu_book_outlined;
      case 'command':
        return Icons.terminal;
      case 'permission':
        return Icons.warning_amber;
      case 'thinking':
        return Icons.psychology_alt_outlined;
      case 'completed':
        return Icons.check_circle_outline;
      case 'error':
        return Icons.error_outline;
      default:
        return Icons.bolt;
    }
  }
}
