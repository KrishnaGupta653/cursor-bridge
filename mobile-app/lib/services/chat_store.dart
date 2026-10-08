import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/chat_models.dart';

/// Sends one command to the extension; resolves to an error message, or null when it was sent.
typedef CommandSender = Future<String?> Function(Map<String, dynamic> command);

/// Agents-window state for the app: the sidebar list, the open chat, the
/// composer, and the replies to commands it sent.
class ChatStore extends ChangeNotifier {
  ChatStore({required this.send});

  final CommandSender send;

  /// The extension drops a watch after 10 minutes unless it is renewed.
  static const watchRenewInterval = Duration(minutes: 2);
  static const pageSize = 40;
  static const chatsPageSize = 50;

  List<ChatRow> chats = [];
  bool sidebarLive = false;
  bool hasMoreChats = false;
  bool loadingChats = false;
  String query = '';
  int _othersLoaded = 0;

  String? selectedChatId;

  /// New Chat was tapped: the next prompt starts a chat in Cursor.
  bool draft = false;
  ChatThread? thread;
  ComposerState? composer;
  List<String> models = [];
  bool loadingModels = false;

  /// A prompt is on its way or the agent is answering it.
  bool awaitingReply = false;
  String? pendingPrompt;
  String? error;
  String? _failedPrompt;

  /// The text of a prompt Cursor did not take, once, so the composer can give it back.
  String? takeFailedPrompt() {
    final p = _failedPrompt;
    _failedPrompt = null;
    return p;
  }

  final Map<String, String> _sent = {};
  /// The chat each outstanding `get_chat` was for, so a late failure only touches that chat.
  final Map<String, String> _sentChat = {};
  final Map<String, Completer<FileDiff>> _diffs = {};
  Timer? _renewTimer;
  Timer? _searchDebounce;
  bool _visible = true;
  bool _resyncing = false;
  int _seq = 0;

  String _nextId() => 'app-${DateTime.now().microsecondsSinceEpoch}-${_seq++}';

  Future<String?> _command(String type, [Map<String, dynamic> fields = const {}]) async {
    final id = _nextId();
    _sent[id] = type;
    if (type == 'get_chat' && fields['chatId'] != null) _sentChat[id] = fields['chatId'].toString();
    if (_sent.length > 200) {
      final oldest = _sent.keys.first;
      _sent.remove(oldest);
      _sentChat.remove(oldest);
    }
    final err = await send({
      'type': type,
      'id': id,
      'deadline': DateTime.now().add(const Duration(minutes: 1)).millisecondsSinceEpoch,
      ...fields,
    });
    if (err != null) {
      _sent.remove(id);
      _settle(type, _sentChat.remove(id));
      _fail(err);
    }
    return err == null ? id : null;
  }

  /// Clears the spinner a command started once it fails, whether at send time or in its reply.
  void _settle(String type, String? chatId) {
    if (type == 'list_chats') loadingChats = false;
    if (type == 'list_models') loadingModels = false;
    final t = thread;
    if (type == 'get_chat' && t != null && chatId == t.chatId) {
      t.loading = false;
      t.loadingOlder = false;
      _resyncing = false;
    }
  }

  void _fail(String message) {
    error = message;
    notifyListeners();
  }

  void clearError() {
    if (error == null) return;
    error = null;
    notifyListeners();
  }

  /// The composer state, only when it describes the chat on screen. A draft has no chat yet,
  /// so a state that names one (the chat open before New Chat) is never shown for it.
  ComposerState? get liveComposer {
    final c = composer;
    if (c == null) return null;
    if (draft) return c.chatId == null ? c : null;
    return c.chatId != null && c.chatId == selectedChatId ? c : null;
  }

  bool get running => (liveComposer?.running ?? false) || awaitingReply;

  ChatRow? get selectedRow =>
      chats.where((c) => c.id == selectedChatId).firstOrNull;

  List<SidebarSection> get sections => groupChats(chats, query: query);

  // ---- Sidebar -------------------------------------------------------------

  Future<void> refreshChats() async {
    loadingChats = true;
    notifyListeners();
    await _command('list_chats', {
      'limit': chatsPageSize,
      if (query.trim().isNotEmpty) 'query': query.trim(),
    });
  }

  Future<void> loadMoreChats() async {
    if (loadingChats) return;
    loadingChats = true;
    notifyListeners();
    await _command('list_chats', {
      'offset': _othersLoaded,
      'limit': chatsPageSize,
      'expand': true,
      if (query.trim().isNotEmpty) 'query': query.trim(),
    });
  }

  void search(String value) {
    query = value;
    notifyListeners();
    _searchDebounce?.cancel();
    _searchDebounce = Timer(const Duration(milliseconds: 400), refreshChats);
  }

  // ---- Chat ----------------------------------------------------------------

  /// Opens [chatId]. [keepPrompt] carries an in-flight prompt over, for a new chat that just got its ID.
  Future<void> selectChat(String chatId, {bool keepPrompt = false}) async {
    final t = thread;
    final failedBefore = t != null && !t.loading && t.items.isEmpty;
    if (chatId == selectedChatId && !draft && t != null && !failedBefore) return;
    final row = chats.where((c) => c.id == chatId).firstOrNull;
    selectedChatId = chatId;
    draft = false;
    _resyncing = false;
    if (!keepPrompt) {
      pendingPrompt = null;
      awaitingReply = false;
    }
    error = null;
    thread = ChatThread(chatId: chatId, title: row?.title ?? '', repoName: row?.group ?? '', loading: true);
    notifyListeners();
    await _command('get_chat', {'chatId': chatId, 'limit': pageSize});
    _scheduleRenew();
  }

  void startNewChat() {
    if (selectedChatId != null) unawaited(_command('unwatch_chat'));
    selectedChatId = null;
    draft = true;
    thread = null;
    pendingPrompt = null;
    awaitingReply = false;
    error = null;
    _renewTimer?.cancel();
    notifyListeners();
  }

  Future<void> loadOlder() async {
    final t = thread;
    if (t == null || !t.hasOlder || t.loadingOlder || t.firstSeq == null) return;
    t.loadingOlder = true;
    notifyListeners();
    await _command('get_chat', {'chatId': t.chatId, 'before': t.firstSeq, 'limit': pageSize});
  }

  Future<void> sendPrompt(String text) async {
    final prompt = text.trim();
    if (prompt.isEmpty) return;
    if (!draft && selectedChatId == null) return;
    pendingPrompt = prompt;
    awaitingReply = true;
    error = null;
    notifyListeners();
    final id = await _command('agent_prompt', {
      'text': prompt,
      if (draft) 'newChat': true else 'chatId': selectedChatId,
    });
    if (id == null) {
      awaitingReply = false;
      pendingPrompt = null;
      _failedPrompt = prompt;
      notifyListeners();
    }
  }

  Future<void> stop() => _command('agent_stop', {if (selectedChatId != null) 'chatId': selectedChatId});

  Future<void> setModel(String model) =>
      _command('set_model', {'model': model, if (selectedChatId != null) 'chatId': selectedChatId});

  Future<void> setMode(String mode) =>
      _command('set_mode', {'mode': mode, if (selectedChatId != null) 'chatId': selectedChatId});

  Future<void> loadModels() async {
    loadingModels = true;
    notifyListeners();
    await _command('list_models');
  }

  /// Approve or reject exactly [request]; the extension refuses if it changed.
  Future<void> resolve(PendingRequest request, {required bool approve}) async {
    final chatId = request.chatId ?? selectedChatId;
    if (chatId == null || (selectedChatId != null && chatId != selectedChatId)) {
      _fail('This request is not tied to a chat. Review it in Cursor.');
      return;
    }
    await _command(approve ? 'approve_action' : 'reject_action', {
      'chatId': chatId,
      'requestId': request.id,
      'confirmed': true,
    });
  }

  Future<FileDiff> fileDiff(String path) async {
    final chatId = selectedChatId;
    if (chatId == null) throw StateError('No chat selected');
    final id = await _command('get_file_diff', {'chatId': chatId, 'path': path});
    if (id == null) throw StateError(error ?? 'Could not request the diff');
    final completer = Completer<FileDiff>();
    _diffs[id] = completer;
    return completer.future.timeout(const Duration(seconds: 30), onTimeout: () {
      _diffs.remove(id);
      throw TimeoutException('The diff did not arrive. Check the connection and try again.');
    });
  }

  // ---- Visibility & watch ----------------------------------------------------

  /// Hidden tabs stop following the chat; becoming visible catches up from the last item.
  void setVisible(bool visible) {
    if (visible == _visible) return;
    _visible = visible;
    final t = thread;
    if (t == null) return;
    if (visible) {
      unawaited(_command('watch_chat', {'chatId': t.chatId, 'fromTotal': t.total}));
      _scheduleRenew();
    } else {
      _renewTimer?.cancel();
      unawaited(_command('unwatch_chat'));
    }
  }

  /// After a reconnect: reload the open chat (deltas may have been missed), which re-watches it.
  Future<void> resume() async {
    final t = thread;
    if (t == null) return;
    await _command('get_chat', {'chatId': t.chatId, 'limit': pageSize});
    _scheduleRenew();
  }

  void _scheduleRenew() {
    _renewTimer?.cancel();
    _renewTimer = Timer.periodic(watchRenewInterval, (_) {
      final t = thread;
      if (!_visible || t == null || t.loading) return;
      unawaited(_command('watch_chat', {'chatId': t.chatId, 'fromTotal': t.total}));
    });
  }

  /// Forget everything tied to the old connection.
  void reset() {
    _renewTimer?.cancel();
    for (final c in _diffs.values) {
      if (!c.isCompleted) c.completeError(StateError('Disconnected'));
    }
    _diffs.clear();
    _sent.clear();
    _sentChat.clear();
    chats = [];
    thread = null;
    composer = null;
    models = [];
    selectedChatId = null;
    draft = false;
    awaitingReply = false;
    pendingPrompt = null;
    error = null;
    _resyncing = false;
    notifyListeners();
  }

  // ---- Inbound -------------------------------------------------------------

  /// Applies one message from the extension; returns false when it is not an Agents-window reply.
  bool applyInbound(Map<String, dynamic> data) {
    final type = data['type']?.toString() ?? '';
    final correlationId = data['correlationId']?.toString();
    switch (type) {
      case 'chats':
        _applyChats(data);
        break;
      case 'chat':
        _applyChat(data);
        break;
      case 'chat_delta':
        _applyDelta(data);
        break;
      case 'composer_state':
        if (data['state'] is Map) {
          final state = ComposerState.fromJson(Map<String, dynamic>.from(data['state']));
          // A watch can still report the previous chat for a moment after switching.
          final watched = data['chatId']?.toString();
          if (!draft && watched != null && watched != selectedChatId) return true;
          composer = state;
          if (!state.running && awaitingReply && pendingPrompt == null) awaitingReply = false;
        }
        break;
      case 'models':
        models = (data['models'] as List? ?? const []).map((m) => m.toString()).toList();
        loadingModels = false;
        break;
      case 'file_diff':
        final completer = correlationId == null ? null : _diffs.remove(correlationId);
        completer?.complete(FileDiff.fromJson(data));
        return true;
      case 'chat_response':
        if (correlationId == null || !_sent.containsKey(correlationId)) return false;
        _sent.remove(correlationId);
        awaitingReply = false;
        pendingPrompt = null;
        final chatId = data['chatId']?.toString() ?? composer?.chatId;
        if (draft && chatId != null && chatId.isNotEmpty) {
          unawaited(selectChat(chatId));
          unawaited(refreshChats());
        }
        break;
      case 'command_result':
        if (correlationId == null || !_sent.containsKey(correlationId)) return false;
        _applyResult(correlationId, data);
        break;
      default:
        return false;
    }
    notifyListeners();
    return true;
  }

  void _applyChats(Map<String, dynamic> data) {
    final rows = (data['chats'] as List? ?? const [])
        .whereType<Map>()
        .map((r) => ChatRow.fromJson(Map<String, dynamic>.from(r)))
        .toList();
    final offset = data['offset'] is int ? data['offset'] as int : 0;
    if (offset == 0) {
      chats = rows;
      _othersLoaded = rows.where((r) => !r.inSidebar).length;
      sidebarLive = data['sidebar'] == true;
    } else {
      final known = chats.map((c) => c.id).toSet();
      chats = [...chats, ...rows.where((r) => !known.contains(r.id))];
      _othersLoaded += rows.length;
    }
    hasMoreChats = data['hasMore'] == true;
    loadingChats = false;
  }

  void _applyChat(Map<String, dynamic> data) {
    final chatId = data['chatId']?.toString();
    final t = thread;
    if (t == null || chatId != t.chatId) return;
    final items = (data['items'] as List? ?? const [])
        .whereType<Map>()
        .map((i) => ChatItem.fromJson(Map<String, dynamic>.from(i)))
        .toList();
    final summary = data['chat'] is Map ? Map<String, dynamic>.from(data['chat']) : null;
    if (summary != null) {
      if (t.title.isEmpty) t.title = summary['title']?.toString() ?? '';
      t.repoName = summary['repoName']?.toString() ?? t.repoName;
    }
    if (data['composer'] is Map) {
      composer = ComposerState.fromJson(Map<String, dynamic>.from(data['composer']));
    }
    if (data['before'] != null) {
      t.prependOlder(items, data['hasOlder'] == true);
      t.loadingOlder = false;
      return;
    }
    t.items = items;
    t.total = data['total'] is int ? data['total'] as int : items.length;
    t.hasOlder = data['hasOlder'] == true;
    t.filesChanged = (data['filesChanged'] as List? ?? const [])
        .whereType<Map>()
        .map((f) => FileEdit.fromJson(Map<String, dynamic>.from(f)))
        .toList();
    t.loading = false;
    _resyncing = false;
    final prompt = pendingPrompt;
    if (prompt != null && items.any((i) => i.role == 'user' && i.text.trim() == prompt)) pendingPrompt = null;
    unawaited(_command('watch_chat', {'chatId': t.chatId, 'fromTotal': t.total}));
  }

  void _applyDelta(Map<String, dynamic> data) {
    final t = thread;
    if (t == null || data['chatId']?.toString() != t.chatId) return;
    final items = (data['items'] as List? ?? const [])
        .whereType<Map>()
        .map((i) => ChatItem.fromJson(Map<String, dynamic>.from(i)))
        .toList();
    final fromSeq = data['fromSeq'] is int ? data['fromSeq'] as int : t.total;
    if (t.loading) return;
    if (!t.applyDelta(fromSeq, data['total'] is int ? data['total'] as int : t.total, items)) {
      // A delta was lost (relay hiccup): reload instead of showing a hole in the chat.
      if (!_resyncing) {
        _resyncing = true;
        unawaited(resume());
      }
      return;
    }
    final prompt = pendingPrompt;
    if (prompt != null && items.any((i) => i.role == 'user' && i.text.trim() == prompt)) {
      pendingPrompt = null;
    }
  }

  void _applyResult(String correlationId, Map<String, dynamic> data) {
    final type = _sent[correlationId] ?? data['command_type']?.toString() ?? '';
    final ok = data['success'] == true;
    if (type != 'agent_prompt') _sent.remove(correlationId);
    final forChat = _sentChat.remove(correlationId);
    if (ok) {
      // A new chat gets its ID once Cursor takes the first prompt: follow it live from here.
      final result = data['data'] is Map ? Map<String, dynamic>.from(data['data']) : const <String, dynamic>{};
      final newChatId = result['chatId']?.toString();
      if (type == 'agent_prompt' && draft && newChatId != null && newChatId.isNotEmpty) {
        unawaited(selectChat(newChatId, keepPrompt: true));
        unawaited(refreshChats());
      }
      return;
    }
    final message = (data['error_message'] ?? data['error'] ?? 'Command failed').toString();
    if (type == 'get_file_diff') {
      _diffs.remove(correlationId)?.completeError(StateError(message));
      return;
    }
    if (type == 'agent_prompt') {
      _sent.remove(correlationId);
      awaitingReply = false;
      _failedPrompt = pendingPrompt;
      pendingPrompt = null;
    }
    _settle(type, forChat);
    if (type == 'watch_chat' || type == 'unwatch_chat') return;
    error = message;
  }

  @override
  void dispose() {
    _renewTimer?.cancel();
    _searchDebounce?.cancel();
    super.dispose();
  }
}
