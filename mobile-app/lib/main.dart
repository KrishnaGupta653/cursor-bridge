import 'dart:async';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'models/connection_models.dart';
import 'services/app_settings.dart';
import 'services/chat_store.dart';
import 'services/connection.dart';
import 'screens/agent_control_center.dart';
import 'screens/connection_landing.dart';
import 'theme/app_theme.dart';
import 'widgets/cr_ui.dart';

// Relay server URL (public default; override requires rebuild)
const String kRelayServerUrl = String.fromEnvironment(
  'RELAY_URL',
  defaultValue: 'https://cursor-remote-rela.vercel.app',
);

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await AppSettings().load();
  runApp(MyApp(savedLogin: await RelayLogin.load()));
}

final ThemeData darkTheme = buildCrDarkTheme();

// ============================================================
// App Root
// ============================================================
class MyApp extends StatelessWidget {
  const MyApp({super.key, this.savedLogin});

  final RelayLogin? savedLogin;

  // Dark-only, like Cursor's Agents window: the screens use fixed Cr colors.
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Cursor Remote',
      theme: darkTheme,
      darkTheme: darkTheme,
      themeMode: ThemeMode.dark,
      home: HomePage(savedLogin: savedLogin),
    );
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key, this.savedLogin});

  /// Read before the first frame, so a refresh goes straight to "Connecting…" instead of the landing page.
  final RelayLogin? savedLogin;

  @override
  State<HomePage> createState() => _HomePageState();
}

// Message type constants
class MessageType {
  static const String normal = 'normal';
  static const String chatResponse = 'chat_response';
  static const String chatResponseChunk = 'chat_response_chunk'; // streaming chunk
  static const String chatResponseComplete =
      'chat_response_complete'; // streaming complete
  static const String chatResponseHeader = 'chat_response_header';
  static const String chatResponseDivider = 'chat_response_divider';
  static const String userMessage = 'user_message';
  static const String userPrompt = 'user_prompt'; // prompt entered by user
  static const String geminiResponse = 'gemini_response';
  static const String terminalOutput = 'terminal_output';
  static const String system = 'system'; // Sent, Received, Command succeeded, etc.
  static const String log = 'log'; // real-time logs
}

// Filter categories
enum MessageFilter {
  aiResponse, // Cursor AI Response
  userPrompt, // user-entered prompts
  system, // Sent, Received, Command succeeded, etc.
  log, // real-time logs
}

// Log levels
enum LogLevel {
  error, // error
  warning, // warning
  info, // info
}

class MessageItem {
  final String text;
  final String type; // a MessageType constant
  final DateTime timestamp;
  String? agentMode; // userPrompt messages only
  LogLevel? logLevel; // log messages only

  MessageItem(this.text,
      {this.type = MessageType.normal, this.agentMode, this.logLevel})
      : timestamp = DateTime.now();

  MessageFilter? get filterCategory {
    switch (type) {
      case MessageType.chatResponse:
      case MessageType.chatResponseChunk:
      case MessageType.chatResponseComplete:
      case MessageType.chatResponseHeader:
      case MessageType.chatResponseDivider:
      case MessageType.geminiResponse:
        return MessageFilter.aiResponse;
      case MessageType.userPrompt:
        return MessageFilter.userPrompt;
      case MessageType.log:
        return MessageFilter.log;
      case MessageType.system:
      case MessageType.normal:
      case MessageType.terminalOutput:
        return MessageFilter.system;
      default:
        return MessageFilter.system;
    }
  }
}

class _HomePageState extends State<HomePage> with WidgetsBindingObserver {
  ConnectionType _connectionType = ConnectionType.relay;

  // Transport (Local / Tunnel / Relay) and the Agents window state
  late final CursorConnection _conn = CursorConnection(relayUrl: kRelayServerUrl);
  late final ChatStore _chats =
      ChatStore(send: (command) async => (await _conn.send(command)).failure);
  String? get _sessionId => _conn.sessionId;
  bool get _isConnected => _conn.connected;
  bool get _isConnecting => _conn.connecting;
  bool get _isReconnecting => _conn.reconnecting;
  int get _reconnectAttempts => _conn.reconnectAttempts;
  String? get _lastConnectionError => _conn.lastError;
  bool _hadConnection = false;
  /// Reconnecting with the saved relay login after a refresh or restart.
  bool _restoringLogin = false;
  /// A dropped connection that is being retried keeps the chat on screen.
  bool get _showSession =>
      _isConnected || (_hadConnection && (_isReconnecting || _isConnecting || _restoringLogin));
  bool _isWaitingForResponse = false; // waiting for AI response

  // Cursor CLI session
  String? _currentCursorSessionId;
  String? _currentClientId;

  // Streaming
  int? _streamingMessageIndex; // index of the message being streamed
  String _streamingText = '';

  // Session and chat history
  Map<String, dynamic>? _sessionInfo; // Current session info
  List<Map<String, dynamic>> _chatHistory = [];
  List<String> _availableSessions = [];
  /// On reconnecting to the same session, apply the get_chat_history response to the main list.
  bool _loadingSessionHistoryForDisplay = false;

  /// A load requested by the "load past messages" button (the response is merged into _messages).
  bool _loadingPastMessages = false;

  // Local server
  final TextEditingController _localIpController = TextEditingController();
  final TextEditingController _localPortController =
      TextEditingController(text: '8766');

  // Agent mode
  String _selectedAgentMode = 'auto'; // auto, agent, ask, plan, debug
  String? _actualSelectedMode; // mode actually picked in auto mode (null if the user chose it)
  MessageItem? _lastUserPrompt; // last user prompt, for updating its mode

  // Agent backend: CLI (new agent) vs CDP (existing Cursor IDE session)
  String _selectedAgentBackend = 'cdp'; // cdp (Agents) | cli — Agents first

  final List<MessageItem> _messages = [];
  final TextEditingController _commandController = TextEditingController();
  final TextEditingController _sessionIdController = TextEditingController();

  // Input field state
  int _textFieldKey = 0; // bumped to recreate the TextField
  DateTime? _lastPromptSubmitTime; // debounces duplicate Enter submits
  final FocusNode _sessionIdFocusNode = FocusNode();
  final FocusNode _localIpFocusNode = FocusNode();
  final FocusNode _commandFocusNode = FocusNode();
  final ScrollController _scrollController = ScrollController();
  // ignore: deprecated_member_use
  final ExpansionTileController _expansionTileController =
      // ignore: deprecated_member_use
      ExpansionTileController();

  /// Scroll buttons are shown only when scrolling up/down is possible.
  bool _canScrollUp = false;
  bool _canScrollDown = false;

  /// Compact view after connecting (large messages + single-line prompt).
  bool _isCompactView = false;

  // Filters (default: only AI responses and user prompts)
  final Map<MessageFilter, bool> _activeFilters = {
    MessageFilter.aiResponse: true,
    MessageFilter.userPrompt: true,
    MessageFilter.system: false,
    MessageFilter.log: false,
  };

  // Per-log-level filters (default: all on)
  final Map<LogLevel, bool> _logLevelFilters = {
    LogLevel.error: true,
    LogLevel.warning: true,
    LogLevel.info: true,
  };

  // Messages after category filters only
  List<MessageItem> get _filteredMessages {
    return _messages.where((msg) {
      final category = msg.filterCategory;
      if (category == null) return true;

      // Log messages also go through the level filters
      if (category == MessageFilter.log &&
          (_activeFilters[MessageFilter.log] ?? false)) {
        final level = msg.logLevel ?? LogLevel.info;
        if (!(_logLevelFilters[level] ?? true)) return false;
      }

      return _activeFilters[category] ?? true;
    }).toList();
  }

  // Search: everything (prompts + responses) or responses only
  static const String _searchScopeAll = 'all';
  static const String _searchScopeAnswerOnly = 'answer_only';
  String _searchQuery = '';
  String _searchScope = _searchScopeAll;

  // Displayed messages after search
  List<MessageItem> get _displayMessages {
    final q = _searchQuery.trim().toLowerCase();
    if (q.isEmpty) return _filteredMessages;
    return _filteredMessages.where((m) {
      final inScope = _searchScope == _searchScopeAnswerOnly
          ? m.filterCategory == MessageFilter.aiResponse
          : true;
      return inScope && m.text.toLowerCase().contains(q);
    }).toList();
  }

  // Create a new relay session, then connect (Generate & Connect)
  Future<void> _createSession() async {
    setState(() {
      _conn.lastError = 'Create the relay session in Cursor first, then enter its ID here.';
      _messages.add(MessageItem(
          'Use Cursor Remote in Cursor to create a session, then Pair Relay Client to obtain a pairing code.',
          type: MessageType.system));
    });
  }

  void _onConnectionChanged() {
    if (mounted) setState(() {});
  }

  void _onSystem(String text) {
    if (!mounted) return;
    setState(() => _messages.add(MessageItem(text, type: MessageType.system)));
    _scrollToBottom();
  }

  /// Runs after every successful connect, whatever the transport.
  void _onConnected() {
    if (!mounted) return;
    _hadConnection = true;
    final relay = _conn.type == ConnectionType.relay;
    _saveConnectionSettings();
    AppSettings().addConnectionHistory(relay
        ? ConnectionHistoryItem(
            type: ConnectionType.relay,
            sessionId: _sessionId,
            timestamp: DateTime.now(),
          )
        : ConnectionHistoryItem(
            type: _conn.type,
            ip: _localIpController.text.trim(),
            port: int.tryParse(_localPortController.text.trim()),
            timestamp: DateTime.now(),
          ));
    try {
      _expansionTileController.collapse();
    } catch (_) {}
    if (relay) _loadingSessionHistoryForDisplay = true;
    Future.delayed(const Duration(milliseconds: 300), () {
      if (!mounted) return;
      _loadChatHistory(sessionId: relay ? _sessionId : null);
    });
    Future.delayed(const Duration(milliseconds: 500), () {
      if (mounted && _selectedAgentBackend == 'cdp') _refreshAgents();
    });
  }

  Future<void> _connectToLocal() async {
    if (_isConnecting) return;

    final asTunnel = _connectionType == ConnectionType.tunnel;
    var host = _localIpController.text.trim();
    if (host.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            asTunnel
                ? 'Paste the Cloudflare Tunnel wss:// URL from the Cursor extension'
                : 'Please enter the PC hostname or IP address',
          ),
        ),
      );
      return;
    }

    // Allow full ws://, wss://, or https:// URLs in the host field
    String scheme = asTunnel ? 'wss' : 'ws';
    int? portFromUrl;
    if (host.startsWith('https://')) {
      host = 'wss://${host.substring('https://'.length)}';
    } else if (host.startsWith('http://')) {
      host = 'ws://${host.substring('http://'.length)}';
    }
    if (host.startsWith('ws://') || host.startsWith('wss://')) {
      try {
        final uri = Uri.parse(host);
        scheme = uri.scheme;
        host = uri.host;
        if (uri.hasPort) portFromUrl = uri.port;
      } catch (_) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Invalid WebSocket URL. Example: wss://xxxx.trycloudflare.com',
            ),
          ),
        );
        return;
      }
    }

    // Strip path leftovers; reject empty host
    host = host.split('/').first.trim();
    if (host.isEmpty || host.contains(' ')) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please enter a valid hostname or IP address')),
      );
      return;
    }

    final portText = _localPortController.text.trim();
    // wss/https tunnels default to 443 when port omitted
    final int? port = portFromUrl ??
        int.tryParse(portText) ??
        ((scheme == 'wss' || scheme == 'https') ? 443 : null);
    if (port == null || port < 1 || port > 65535) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Port must be a number between 1 and 65535')),
      );
      return;
    }

    // Reflect parsed values back into the form
    _localIpController.text = host;
    _localPortController.text = port.toString();

    if (scheme == 'ws') {
      if (kIsWeb) {
        await showDialog<void>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('Local mode is not available in the browser'),
            content: const Text(
                'Browsers block unencrypted ws:// connections from this page, and the pairing code and chats '
                'would cross the network in plain text. Use Relay, or a Tunnel (wss://) URL from the Cursor extension.'),
            actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK'))],
          ),
        );
        return;
      }
      if (!isPrivateHost(host) && !await _confirmPlainConnection(host)) return;
    }

    await _conn.connectLocal('$scheme://$host:$port',
        tunnel: asTunnel, label: asTunnel ? host : '$host:$port');
  }

  Future<bool> _confirmPlainConnection(String host) async {
    final go = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Unencrypted connection'),
        content: Text('$host is not a home or office network address. Over ws:// your pairing code, '
            'chats and code travel in plain text that anyone on the path can read.\n\n'
            'Use Relay, or a Tunnel (wss://) URL, unless you know this network is private.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Connect anyway')),
        ],
      ),
    );
    return go == true && mounted;
  }

  Future<String?> _showLocalPairDialog() async {
    if (!mounted) return null;
    String secret = '';
    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Pair with Cursor'),
        content: TextField(
          autofocus: true,
          enableSuggestions: false, autocorrect: false,
          decoration: const InputDecoration(
            labelText: 'Pairing code',
            helperText: 'Run Cursor Remote: Pair Client in Cursor first.',
          ),
          onChanged: (value) => secret = value.trim(),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(context, true),
              child: const Text('Pair')),
        ],
      ),
    );
    return accepted == true ? secret : null;
  }

  /// One handler for every inbound message (Local, Tunnel and Relay).
  void _handleInbound(Map<String, dynamic> messageData) {
    if (!mounted) return;
    if (_chats.applyInbound(messageData)) {
      _syncWaitingWithAgents();
      return;
    }
    final type = messageData['type'];

    setState(() {
      if (type == 'command_result') {
        if (messageData['success'] == true) {
          final commandType = messageData['command_type'] as String? ?? '';

          // Session info result
          if (commandType == 'get_session_info' &&
              messageData['data'] != null) {
            _sessionInfo = messageData['data'] as Map<String, dynamic>;
            if (_sessionInfo!['currentSessionId'] != null) {
              _currentCursorSessionId =
                  _sessionInfo!['currentSessionId'] as String;
            }
            if (_sessionInfo!['clientId'] != null) {
              _currentClientId = _sessionInfo!['clientId'] as String;
            }
          }
          // Chat history result (the extension sends either an array or { entries: [] } in data)
          else if (commandType == 'get_chat_history' &&
              messageData['data'] != null) {
            final raw = messageData['data'];
            final List<Map<String, dynamic>> entries = raw is List
                ? List<Map<String, dynamic>>.from(
                    raw.map((e) => e as Map<String, dynamic>))
                : (raw is Map<String, dynamic> && raw['entries'] != null)
                    ? List<Map<String, dynamic>>.from((raw['entries'] as List)
                        .map((e) => e as Map<String, dynamic>))
                    : <Map<String, dynamic>>[];
            if (entries.isNotEmpty ||
                _loadingSessionHistoryForDisplay ||
                _loadingPastMessages) {
              _chatHistory = entries;
              _availableSessions = _chatHistory
                  .map((entry) => entry['sessionId'] as String? ?? '')
                  .where((id) => id.isNotEmpty)
                  .toSet()
                  .toList();
            }
            if (_loadingSessionHistoryForDisplay) {
              // After connect: show only current relay session history
              if (entries.isNotEmpty) {
                _applyChatHistoryToMessages(entries,
                    replaceConversation: true);
              }
              _loadingSessionHistoryForDisplay = false;
            }
            if (_loadingPastMessages) {
              if (entries.isNotEmpty) {
                _applyChatHistoryToMessages(entries, skipIfExists: true);
              }
              _loadingPastMessages = false;
            }
          }

          // Don't show the generic success message for session/history queries
          if (commandType != 'get_session_info' &&
              commandType != 'get_chat_history') {
            _messages.add(
                MessageItem('✅ Command succeeded', type: MessageType.system));
          }
          if (commandType == 'stop_prompt') {
            _isWaitingForResponse = false;
          }
        } else {
          _messages.add(MessageItem('❌ Command failed: ${messageData['error'] ?? messageData['error_message']}',
              type: MessageType.system));
          _isWaitingForResponse = false;
        }
      } else if (type == 'error') {
        _messages.add(MessageItem('❌ Error: ${messageData['message']}',
            type: MessageType.system));
        _isWaitingForResponse = false;
      } else if (type == 'user_message') {
        final text = messageData['text'] ?? '';
        _messages
            .add(MessageItem('💬 You: $text', type: MessageType.userMessage));
      } else if (type == 'gemini_response') {
        final text = messageData['text'] ?? '';
        _messages.add(
            MessageItem('🤖 Gemini: $text', type: MessageType.geminiResponse));
      } else if (type == 'terminal_output') {
        final text = messageData['text'] ?? '';
        _messages.add(MessageItem('📟 Terminal: $text',
            type: MessageType.terminalOutput));
      } else if (type == 'chat_response_chunk') {
        // Streaming chunk
        final chunkText = messageData['text'] ?? '';
        final fullText = messageData['fullText'] ?? chunkText;
        final isReplace = messageData['isReplace'] == true;

        if (messageData['sessionId'] != null) {
          _currentCursorSessionId = messageData['sessionId'] as String;
        }
        final newClientId = messageData['clientId'] as String?;
        if (newClientId != null && _currentClientId != newClientId) {
          _currentClientId = newClientId;
          _loadSessionInfo();
          _loadChatHistory();
        }

        // First chunk: add the message
        if (_streamingMessageIndex == null) {
          _messages
              .add(MessageItem('', type: MessageType.chatResponseDivider));
          _messages.add(MessageItem('🤖 Cursor AI Response',
              type: MessageType.chatResponseHeader));
          _streamingText = isReplace ? fullText : chunkText;
          _messages.add(MessageItem(_streamingText,
              type: MessageType.chatResponseChunk));
          _streamingMessageIndex = _messages.length - 1;
        } else {
          // Update the existing streaming message
          if (isReplace) {
            _streamingText = fullText;
          } else {
            _streamingText += chunkText;
          }
          if (_streamingMessageIndex! < _messages.length) {
            _messages[_streamingMessageIndex!] = MessageItem(_streamingText,
                type: MessageType.chatResponseChunk);
          }
        }
      } else if (type == 'chat_response_complete') {
        // Streaming finished
        if (_streamingMessageIndex != null &&
            _streamingMessageIndex! < _messages.length) {
          _messages[_streamingMessageIndex!] =
              MessageItem(_streamingText, type: MessageType.chatResponse);
          _streamingMessageIndex = null;
          _streamingText = '';
        }
        final newClientId = messageData['clientId'] as String?;
        if (newClientId != null && _currentClientId != newClientId) {
          _currentClientId = newClientId;
          _loadSessionInfo();
        }
        if (_currentClientId != null) {
          Future.delayed(const Duration(milliseconds: 500), () {
            _loadChatHistory();
          });
        }
        _isWaitingForResponse = false;
      } else if (type == 'chat_response') {
        // Non-streaming response (CLI)
        if (messageData['sessionId'] != null) {
          _currentCursorSessionId = messageData['sessionId'] as String;
        }
        final newClientId = messageData['clientId'] as String?;
        if (newClientId != null && _currentClientId != newClientId) {
          // When clientId is first set or changes, fetch session info and history
          _currentClientId = newClientId;
          _loadSessionInfo();
          _loadChatHistory();
        } else if (_currentClientId != null) {
          // Same clientId: just refresh the history
          Future.delayed(const Duration(milliseconds: 500), () {
            _loadChatHistory();
          });
        }
        final text = messageData['text'] ?? '';
        _messages.add(MessageItem('', type: MessageType.chatResponseDivider));
        _messages.add(MessageItem('🤖 Cursor AI Response',
            type: MessageType.chatResponseHeader));
        _messages.add(MessageItem(text, type: MessageType.chatResponse));
        _messages.add(MessageItem('', type: MessageType.chatResponseDivider));
        _isWaitingForResponse = false;
      } else if (type == 'agent_mode_selected') {
        _applyAgentModeSelected(messageData);
      } else if (type == 'log') {
        _messages.add(_logMessageItem(messageData));
      } else if (type == 'connection_status') {
        final status = messageData['status'] ?? 'unknown';
        final message = messageData['message'] ?? '';
        final errorCode = messageData['errorCode']?.toString();
        String statusText = '';
        switch (status) {
          case 'connected':
            statusText = '✅ $message';
            _conn.stopReconnect();
            _conn.resetReconnectAttempts();
            break;
          case 'disconnected':
            statusText = '⚠️ $message';
            break;
          case 'error':
            final detail = (errorCode != null && errorCode.isNotEmpty)
                ? '$message ($errorCode)'
                : message;
            statusText = '❌ $detail';
            _conn.lastError = detail;
            break;
        }
        if (statusText.isNotEmpty) {
          _messages.add(MessageItem(statusText, type: MessageType.system));
        }
      }
    });
    _scrollToBottom();
  }

  /// The CLI "waiting" spinner must not stay on when an Agents-window run finishes.
  void _syncWaitingWithAgents() {
    if (_isWaitingForResponse && _selectedAgentBackend == 'cdp' && !_chats.running &&
        !_chats.awaitingReply) {
      setState(() => _isWaitingForResponse = false);
    }
  }

  void _applyAgentModeSelected(Map<String, dynamic> messageData) {
    final requestedMode = messageData['requestedMode'] ?? 'auto';
    final actualMode = messageData['actualMode'] ?? 'agent';
    final displayName = messageData['displayName'] ?? actualMode;
    // Auto mode only: tag the most recent user prompt that has no mode yet
    if (requestedMode == 'auto' && _selectedAgentMode == 'auto') {
      _actualSelectedMode = actualMode;
      for (int i = _messages.length - 1; i >= 0; i--) {
        if (_messages[i].type == MessageType.userPrompt &&
            _messages[i].agentMode == null) {
          final updatedItem = MessageItem(
            _messages[i].text,
            type: _messages[i].type,
            agentMode: actualMode,
          );
          if (_lastUserPrompt != null &&
              _lastUserPrompt!.text == _messages[i].text) {
            _lastUserPrompt = updatedItem;
          }
          _messages[i] = updatedItem;
          break;
        }
      }
    }
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('🤖 Auto mode: $displayName'),
        duration: const Duration(seconds: 2),
        backgroundColor: Colors.blue.shade700,
      ),
    );
  }

  MessageItem _logMessageItem(Map<String, dynamic> messageData) {
    final logLevelStr = messageData['level'] ?? 'info';
    final logMessage = messageData['message'] ?? '';
    final logSource = messageData['source'] ?? 'unknown';
    final logError = messageData['error'];
    final level = switch (logLevelStr) {
      'error' => LogLevel.error,
      'warn' || 'warning' => LogLevel.warning,
      _ => LogLevel.info,
    };
    final prefix = switch (logSource) {
      'extension' => '🔌 [Extension]',
      _ => '📝 [Log]',
    };
    var logText = '$prefix $logMessage';
    if (logError != null) logText += ' - Error: $logError';
    return MessageItem(logText, type: MessageType.log, logLevel: level);
  }

  /// Reload the Agents sidebar and resume watching the open chat (after connect / reconnect).
  void _refreshAgents() {
    if (!_isConnected) return;
    _chats.refreshChats();
    _chats.resume();
  }

  Future<void> _submitPromptToAgent(String text, {bool newSession = false}) {
    return _sendCommand(
      'insert_text',
      text: text,
      prompt: true,
      execute: true,
      newSession: newSession,
      agentMode: _selectedAgentMode,
      agentBackend: 'cli',
    );
  }

  // PIN input dialog (called on 403 PIN_REQUIRED)
  Future<String?> _showPinDialog() async {
    if (!mounted) return null;
    final controller = TextEditingController();
    final navigator = Navigator.of(context);
    return showDialog<String>(
      context: context,
      barrierDismissible: false,
      useSafeArea: true,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Relay pairing code'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Run Cursor Remote: Pair Relay Client in Cursor and paste the single-use code.',
                style: TextStyle(fontSize: 14),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: controller,
                keyboardType: TextInputType.text,
                maxLength: 43,
                autofocus: true,
                textInputAction: TextInputAction.done,
                onSubmitted: (_) => navigator.pop(controller.text.trim()),
                enableSuggestions: false,
                autocorrect: false,
                decoration: const InputDecoration(
                  labelText: 'Pairing code',
                  hintText: 'Single-use code from Cursor',
                  counterText: '',
                  border: OutlineInputBorder(),
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => navigator.pop(null),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => navigator.pop(controller.text.trim()),
            child: const Text('OK'),
          ),
        ],
      ),
    );
  }

  // Connect to an existing session (PIN only required when set by PC)
  Future<void> _connectToSession(String sessionId) async {
    if (sessionId.trim().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please enter a Session ID')),
      );
      return;
    }
    await _conn.connectRelay(sessionId);
  }

  void _connect() {
    if (_isConnecting || _isConnected) return;
    if (_connectionType == ConnectionType.local ||
        _connectionType == ConnectionType.tunnel) {
      _connectToLocal();
    } else {
      final sessionId = _sessionIdController.text.trim();
      if (sessionId.isEmpty) {
        // Generate & Connect: create a relay session, then join it
        _createSession();
        return;
      }
      _connectToSession(sessionId);
    }
  }

  // Connect from history
  void _connectFromHistory(ConnectionHistoryItem item) {
    setState(() {
      _connectionType = item.type;
      if (item.type == ConnectionType.local ||
          item.type == ConnectionType.tunnel) {
        _localIpController.text = item.ip ?? '';
        if (item.port != null) {
          _localPortController.text = item.port!.toString();
        } else if (item.type == ConnectionType.tunnel) {
          _localPortController.text = '443';
        }
      } else {
        _sessionIdController.text = item.sessionId ?? '';
      }
    });

    _connect();
  }

  // User-friendly display name for a mode
  String _getModeDisplayName(String mode) {
    switch (mode) {
      case 'agent':
        return 'Agent';
      case 'ask':
        return 'Ask';
      case 'plan':
        return 'Plan';
      case 'debug':
        return 'Debug';
      case 'auto':
        return 'Auto';
      default:
        return mode;
    }
  }

  // Icon for a mode
  IconData _getModeIcon(String mode) {
    switch (mode) {
      case 'agent':
        return Icons.code;
      case 'ask':
        return Icons.help_outline;
      case 'plan':
        return Icons.assignment;
      case 'debug':
        return Icons.bug_report;
      case 'auto':
        return Icons.auto_awesome;
      default:
        return Icons.smart_toy;
    }
  }

  // Pick an agent mode from the prompt text (same logic as the extension's detectAgentMode)
  String? _detectAgentMode(String text) {
    final lowerText = text.toLowerCase();

    // Debug mode keywords
    const debugKeywords = [
      'bug',
      'error',
      'fix',
      'debug',
      'issue',
      'problem',
      'crash',
      'exception',
      'trace',
      'log'
    ];
    if (debugKeywords.any((keyword) => lowerText.contains(keyword))) {
      // Bug keywords present, but it may just be a question
      if (lowerText.contains('why') ||
          lowerText.contains('what') ||
          lowerText.contains('how') ||
          lowerText.contains('?')) {
        // Questions go to Ask mode
        if (lowerText.contains('explain') ||
            lowerText.contains('understand') ||
            lowerText.contains('learn')) {
          return 'ask';
        }
      }
      return 'debug';
    }

    // Plan mode keywords
    const planKeywords = [
      'plan',
      'design',
      'architecture',
      'implement',
      'create',
      'build',
      'feature',
      'refactor',
      'analyze',
      'analysis',
      'project',
      'review',
      'overview',
      'structure'
    ];
    if (planKeywords.any((keyword) => lowerText.contains(keyword))) {
      // Keywords that suggest a complex task
      const complexKeywords = [
        'multiple',
        'several',
        'many',
        'system',
        'module',
        'component',
        'project',
        '\uC804\uCCB4', // Korean "entire"
        '\uBAA8\uB4E0', // Korean "all"
        '\uC804\uBC18' // Korean "overall"
      ];
      if (complexKeywords.any((keyword) => lowerText.contains(keyword))) {
        return 'plan';
      }
      // "analyze the project"-style prompts are Plan mode too
      if (lowerText.contains('analyze') ||
          lowerText.contains('analysis') ||
          lowerText.contains('\uBD84\uC11D')) {
        return 'plan';
      }
    }

    // Ask mode keywords (questions, learning, exploring)
    const askKeywords = [
      'explain',
      'what is',
      'how does',
      'why',
      'understand',
      'learn',
      'show me',
      'tell me'
    ];
    if (askKeywords.any((keyword) => lowerText.contains(keyword)) ||
        lowerText.endsWith('?')) {
      return 'ask';
    }

    // Default: Agent mode (writing/editing code)
    return null; // null means the default Agent mode
  }

  /// Human-readable connection status (also used for screen readers)
  String get _connectionStatusLabel {
    if (_isConnected) return 'Connected';
    if (_isReconnecting) return 'Reconnecting';
    if (_isConnecting) return 'Connecting';
    if (_lastConnectionError != null) return 'Connection failed';
    return 'Not Connected';
  }

  Future<void> _disconnect() async {
    if (_conn.relaySession != null) {
      await _confirmLogOut();
      return;
    }
    _hadConnection = false;
    _chats.reset();
    if (mounted) {
      setState(() {
        _isWaitingForResponse = false;
      });
    }
    final warning = await _conn.disconnect();
    if (warning != null && mounted) setState(() => _conn.lastError = warning);
  }

  /// Asks first, then signs this phone out of the relay session. True if it logged out.
  Future<bool> _confirmLogOut() async {
    final session = _conn.relaySession;
    if (session == null) return false;
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Log out'),
        content: Text(_conn.pairedWithReusableCode
            ? "Log out of session $session? You can reconnect with the session's pairing code while it has uses left."
            : "Log out of session $session? You'll need a new pairing code to connect again."),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Log out')),
        ],
      ),
    );
    if (ok != true || !mounted) return false;
    _hadConnection = false;
    _restoringLogin = false;
    _chats.reset();
    setState(() => _isWaitingForResponse = false);
    final warning = await _conn.logOut();
    if (mounted) setState(() => _conn.lastError = warning);
    return true;
  }

  void _stopReconnect() => _conn.stopReconnect();

  // Manual reconnect
  void _manualReconnect() {
    _conn.stopReconnect();
    _conn.resetReconnectAttempts();
    _connect();
  }

  Future<void> _sendCommand(String type,
      {String? text,
      String? command,
      List<dynamic>? args,
      bool? prompt,
      bool? terminal,
      bool? execute,
      String? action,
      bool? newSession,
      String? clientId,
      String? sessionId,
      String? relaySessionId,
      int? limit,
      String? agentMode,
      String? agentBackend,
      String? requestId,
      String? historyId}) async {
    if (!_isConnected) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Not connected')),
        );
      }
      return;
    }

    // Without an explicit agentMode, use the selected mode (or auto)
    final mode = agentMode ?? _selectedAgentMode;
    final backend = agentBackend ?? _selectedAgentBackend;

    // In auto mode, detect the mode from the prompt text up front
    String? finalModeForCommand;
    if (prompt == true && text != null && mode == 'auto') {
      final detectedMode = _detectAgentMode(text);
      finalModeForCommand = detectedMode ?? 'agent'; // default to Agent mode if nothing is detected
    } else if (mode != 'auto') {
      finalModeForCommand = mode;
    }

    final commandData = {
      'type': type,
      'id': DateTime.now().microsecondsSinceEpoch.toString(),
      'deadline': DateTime.now().add(const Duration(minutes: 1)).millisecondsSinceEpoch,
      if (text != null) 'text': text,
      if (command != null) 'command': command,
      if (args != null) 'args': args,
      if (prompt != null) 'prompt': prompt,
      if (terminal != null) 'terminal': terminal,
      if (execute != null) 'execute': execute,
      if (action != null) 'action': action,
      if (newSession != null) 'newSession': newSession,
      if (clientId != null) 'clientId': clientId,
      if (sessionId != null) 'sessionId': sessionId,
      if (relaySessionId != null) 'relaySessionId': relaySessionId,
      if (limit != null) 'limit': limit,
      // Pass the detected mode even in auto mode so it's saved in history
      if (finalModeForCommand != null) 'agentMode': finalModeForCommand,
      if (backend.isNotEmpty) 'agentBackend': backend,
      if (requestId != null) 'requestId': requestId,
      if (historyId != null) 'historyId': historyId,
    };

    // Record the user prompt separately and mark that a response is pending
    if (prompt == true && execute == true && text != null) {
      setState(() {
        _isWaitingForResponse = true;
        final promptItem = MessageItem(
          text,
          type: MessageType.userPrompt,
          agentMode: finalModeForCommand ?? mode, // detected or selected mode
        );
        _lastUserPrompt = promptItem;
        _messages.add(promptItem);
      });
    }

    final result = await _conn.send(commandData);
    if (!mounted) return;
    final failure = result.failure;
    setState(() {
      if (failure != null) {
        _messages.add(MessageItem('❌ Send failed: $failure',
            type: MessageType.system));
        _isWaitingForResponse = false;
      } else {
        _messages.add(MessageItem(
            _conn.isLocal
                ? '✅ Message sent to local server'
                : '✅ Message sent — waiting for response…',
            type: MessageType.system));
      }
    });
    _scrollToBottom();
  }

  void _scrollToBottom() {
    // Scroll on the next frame, after the widget is built
    if (!mounted) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _scrollController.hasClients) {
        try {
          _scrollController.animateTo(
            _scrollController.position.maxScrollExtent,
            duration: const Duration(milliseconds: 300),
            curve: Curves.easeOut,
          );
        } catch (e) {
          // Ignore scroll errors
        }
      }
    });
  }

  Widget _buildMessageItem(MessageItem message) {
    // Divider
    if (message.type == MessageType.chatResponseDivider) {
      return const Divider(
        height: 1,
        thickness: 2,
        color: Colors.blue,
      );
    }

    // Header
    if (message.type == MessageType.chatResponseHeader) {
      return Container(
        margin: const EdgeInsets.symmetric(horizontal: 8.0, vertical: 4.0),
        padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 12.0),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.primaryContainer,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          children: [
            Icon(
              Icons.smart_toy,
              size: 20,
              color: Theme.of(context).colorScheme.onPrimaryContainer,
            ),
            const SizedBox(width: 12),
            Text(
              message.text,
              style: TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w600,
                color: Theme.of(context).colorScheme.onPrimaryContainer,
              ),
            ),
          ],
        ),
      );
    }

    // Chat response body (streaming)
    if (message.type == MessageType.chatResponseChunk) {
      return Container(
        margin: const EdgeInsets.symmetric(horizontal: 8.0, vertical: 4.0),
        padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 12.0),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: Theme.of(context).colorScheme.outline.withValues(alpha: 0.1),
            width: 1,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: SelectableText(
                    message.text,
                    style: const TextStyle(
                      fontSize: 13,
                      height: 1.5,
                    ),
                  ),
                ),
                // Streaming indicator
                const SizedBox(width: 8),
                TweenAnimationBuilder<double>(
                  tween: Tween(begin: 0.0, end: 1.0),
                  duration: const Duration(milliseconds: 500),
                  builder: (context, value, child) {
                    return Opacity(
                      opacity: value,
                      child: Container(
                        width: 8,
                        height: 8,
                        decoration: const BoxDecoration(
                          color: Colors.blue,
                          shape: BoxShape.circle,
                        ),
                      ),
                    );
                  },
                  onEnd: () {
                    // Repeat the animation
                    if (mounted) {
                      setState(() {});
                    }
                  },
                ),
              ],
            ),
          ],
        ),
      );
    }

    // Chat response body (complete)
    if (message.type == MessageType.chatResponse) {
      return Container(
        margin: const EdgeInsets.symmetric(horizontal: 8.0, vertical: 4.0),
        padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 12.0),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: Theme.of(context).colorScheme.outline.withValues(alpha: 0.1),
            width: 1,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SelectableText(
              message.text,
              style: const TextStyle(
                fontSize: 13,
                height: 1.5,
              ),
            ),
            const SizedBox(height: 4),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                IconButton(
                  icon: const Icon(Icons.copy, size: 16),
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(),
                  onPressed: () {
                    Clipboard.setData(ClipboardData(text: message.text));
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('Copied to clipboard'),
                        duration: Duration(seconds: 1),
                      ),
                    );
                  },
                ),
              ],
            ),
          ],
        ),
      );
    }

    // User prompt, visually distinct
    if (message.type == MessageType.userPrompt) {
      return Container(
        margin: const EdgeInsets.symmetric(horizontal: 8.0, vertical: 4.0),
        padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 12.0),
        decoration: BoxDecoration(
          color:
              Theme.of(context).colorScheme.secondaryContainer.withValues(alpha: 0.3),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: Theme.of(context).colorScheme.secondary.withValues(alpha: 0.2),
            width: 1,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(6),
                  decoration: BoxDecoration(
                    color: Theme.of(context).colorScheme.secondaryContainer,
                    shape: BoxShape.circle,
                  ),
                  child: Icon(
                    Icons.person,
                    size: 16,
                    color: Theme.of(context).colorScheme.onSecondaryContainer,
                  ),
                ),
                const SizedBox(width: 12),
                Text(
                  '📝 Your Prompt',
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: Theme.of(context).colorScheme.onSurface,
                  ),
                ),
                // Agent mode badge (whenever non-null and not auto; auto mode is pre-detected so it shows too)
                if (message.agentMode != null &&
                    message.agentMode!.isNotEmpty &&
                    message.agentMode != 'auto') ...[
                  const SizedBox(width: 8),
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(
                      color: Colors.blue.shade100,
                      borderRadius: BorderRadius.circular(4),
                      border:
                          Border.all(color: Colors.blue.shade300, width: 0.5),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          _getModeIcon(message.agentMode!),
                          size: 12,
                          color: Colors.blue.shade700,
                        ),
                        const SizedBox(width: 4),
                        Text(
                          _getModeDisplayName(message.agentMode!),
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w500,
                            color: Colors.blue.shade700,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
                const Spacer(),
                Text(
                  _formatTime(message.timestamp),
                  style: TextStyle(
                    fontSize: 11,
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            SelectableText(
              message.text,
              style: const TextStyle(
                fontSize: 13,
                height: 1.5,
              ),
            ),
            const SizedBox(height: 4),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                IconButton(
                  icon: const Icon(Icons.copy, size: 16),
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(),
                  onPressed: () {
                    Clipboard.setData(ClipboardData(text: message.text));
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('Copied to clipboard'),
                        duration: Duration(seconds: 1),
                      ),
                    );
                  },
                ),
              ],
            ),
          ],
        ),
      );
    }

    // Log message style
    if (message.type == MessageType.log) {
      // Color by log level
      Color logColor;
      IconData logIcon;

      switch (message.logLevel ?? LogLevel.info) {
        case LogLevel.error:
          logColor = Theme.of(context).colorScheme.error;
          logIcon = Icons.error;
        case LogLevel.warning:
          logColor = const Color(0xFFFF9800); // orange
          logIcon = Icons.warning;
        case LogLevel.info:
          logColor = Theme.of(context).colorScheme.tertiary;
          logIcon = Icons.info;
      }

      return Container(
        margin: const EdgeInsets.symmetric(horizontal: 8.0, vertical: 2.0),
        padding: const EdgeInsets.symmetric(horizontal: 12.0, vertical: 6.0),
        decoration: BoxDecoration(
          color: logColor.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(6.0),
          border: Border.all(color: logColor.withValues(alpha: 0.3), width: 1),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              logIcon,
              size: 14,
              color: logColor,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: SelectableText(
                message.text,
                style: TextStyle(
                  fontSize: 11,
                  color: logColor.withValues(alpha: 0.9),
                  fontFamily: 'monospace',
                  height: 1.4,
                ),
              ),
            ),
          ],
        ),
      );
    }

    // System message style
    if (message.type == MessageType.system) {
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 6.0),
        child: Row(
          children: [
            Icon(
              _getSystemMessageIcon(message.text),
              size: 14,
              color: Colors.grey[600],
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                message.text,
                style: TextStyle(
                  fontSize: 12,
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                  fontStyle: FontStyle.italic,
                ),
              ),
            ),
            IconButton(
              icon: const Icon(Icons.copy, size: 14),
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(),
              iconSize: 14,
              color: Theme.of(context)
                  .colorScheme
                  .onSurfaceVariant
                  .withValues(alpha: 0.6),
              onPressed: () {
                Clipboard.setData(ClipboardData(text: message.text));
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                    content: Text('Message copied to clipboard'),
                    duration: Duration(seconds: 1),
                  ),
                );
              },
            ),
          ],
        ),
      );
    }

    // Plain message
    return ListTile(
      title: Text(
        message.text,
        style: const TextStyle(fontSize: 13),
      ),
      dense: true,
      contentPadding: const EdgeInsets.symmetric(
        horizontal: 16.0,
        vertical: 2.0,
      ),
      trailing: IconButton(
        icon: const Icon(Icons.copy, size: 16),
        padding: EdgeInsets.zero,
        constraints: const BoxConstraints(),
        onPressed: () {
          Clipboard.setData(ClipboardData(text: message.text));
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Message copied to clipboard'),
              duration: Duration(seconds: 1),
            ),
          );
        },
      ),
    );
  }

  // System message icon
  IconData _getSystemMessageIcon(String text) {
    if (text.startsWith('✅')) return Icons.check_circle;
    if (text.startsWith('❌')) return Icons.error;
    if (text.startsWith('⚠️')) return Icons.warning;
    if (text.startsWith('Sent:')) return Icons.send;
    if (text.startsWith('Received:')) return Icons.download;
    if (text.contains('Connected')) return Icons.link;
    if (text.contains('Disconnected') || text.contains('Connection')) {
      return Icons.link_off;
    }
    return Icons.info_outline;
  }

  // Time formatting
  String _formatTime(DateTime time) {
    return '${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}:${time.second.toString().padLeft(2, '0')}';
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _conn
      ..onInbound = _handleInbound
      ..onSystem = _onSystem
      ..onConnected = _onConnected
      ..onGaveUp = (() {
        _hadConnection = false;
        _restoringLogin = false;
      })
      ..askPairingCode = (({required bool relay}) =>
          relay ? _showPinDialog() : _showLocalPairDialog())
      ..isBusy = (() => _chats.running || _chats.awaitingReply || _isWaitingForResponse)
      ..addListener(_onConnectionChanged);
    final saved = widget.savedLogin;
    if (saved != null) {
      if (!saved.expired) {
        _hadConnection = true;
        _restoringLogin = true;
        _connectionType = ConnectionType.relay;
        _sessionIdController.text = saved.sessionId;
      }
      // After the first frame: the connection notifies listeners as soon as it starts.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _conn.restoreRelayLogin(saved).whenComplete(() {
          if (mounted) setState(() => _restoringLogin = false);
        });
      });
    }
    _loadConnectionSettings();
    // Apply the default agent mode from settings
    _selectedAgentMode = AppSettings().defaultAgentMode;
    // Listen for settings changes
    AppSettings().addListener(_onAppSettingsChanged);
    _scrollController.addListener(_updateScrollButtonVisibility);
    WidgetsBinding.instance
        .addPostFrameCallback((_) => _updateScrollButtonVisibility());
  }

  void _updateScrollButtonVisibility() {
    if (!mounted || !_scrollController.hasClients) return;
    final p = _scrollController.position;
    const threshold = 4.0;
    final canUp = p.pixels > p.minScrollExtent + threshold;
    final canDown = p.pixels < p.maxScrollExtent - threshold;
    if (canUp != _canScrollUp || canDown != _canScrollDown) {
      setState(() {
        _canScrollUp = canUp;
        _canScrollDown = canDown;
      });
    }
  }

  void _onAppSettingsChanged() {
    if (mounted) {
      setState(() {
        // Rebuild on settings changes (e.g. history visibility)
      });
    }
  }

  // Clear the input, fully resetting the IME composing buffer
  void _clearCommandInput() {
    _commandController.clear();

    // Change the key to recreate the TextField (fully resets IME state)
    setState(() {
      _textFieldKey++;
    });

    // Focus the new TextField
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _commandFocusNode.requestFocus();
      }
    });
  }

  // Load connection settings (SharedPreferences)
  Future<void> _loadConnectionSettings() async {
    try {
      final prefs = await SharedPreferences.getInstance();

      final connectionTypeStr = prefs.getString('connection_type');
      if (connectionTypeStr != null && !_restoringLogin) {
        setState(() {
          _connectionType = connectionTypeStr == 'local'
              ? ConnectionType.local
              : connectionTypeStr == 'tunnel'
                  ? ConnectionType.tunnel
                  : ConnectionType.relay;
        });
      }

      // PC (extension) IP address
      final savedIp = prefs.getString('pc_server_ip');
      if (savedIp != null && savedIp.isNotEmpty) {
        _localIpController.text = savedIp;
      }
      final savedPort = prefs.getString('local_ws_port');
      if (savedPort != null && savedPort.isNotEmpty) {
        _localPortController.text = savedPort;
      }

      // Last session ID (optional)
      final lastSessionId = prefs.getString('last_session_id');
      if (lastSessionId != null && lastSessionId.isNotEmpty && !_restoringLogin) {
        _sessionIdController.text = lastSessionId;
      }
    } catch (e) {
      // Ignore errors (prefs may not exist on first run)
    }
  }

  // Save connection settings (SharedPreferences)
  Future<void> _saveConnectionSettings() async {
    try {
      final prefs = await SharedPreferences.getInstance();

      await prefs.setString(
          'connection_type',
          _connectionType == ConnectionType.local
              ? 'local'
              : _connectionType == ConnectionType.tunnel
                  ? 'tunnel'
                  : 'relay');

      // PC (extension) IP address
      if (_localIpController.text.trim().isNotEmpty) {
        await prefs.setString('pc_server_ip', _localIpController.text.trim());
      }
      if (_localPortController.text.trim().isNotEmpty) {
        await prefs.setString('local_ws_port', _localPortController.text.trim());
      }

      // Session ID (on successful connection)
      if (_sessionId != null && _sessionId!.isNotEmpty) {
        await prefs.setString('last_session_id', _sessionId!);
      }
    } catch (e) {
      // Ignore errors
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    super.didChangeAppLifecycleState(state);
    // Hidden apps stop polling the relay and watching chats; resuming catches up.
    final visible = state == AppLifecycleState.resumed ||
        state == AppLifecycleState.inactive;
    _conn.setVisible(visible);
    _chats.setVisible(visible);
    if (state == AppLifecycleState.resumed && mounted) {
      Future.microtask(() {
        if (mounted) setState(() {});
      });
    }
  }

  // Fetch session info
  Future<void> _loadSessionInfo() async {
    if (!_isConnected) return;

    // No clientId yet: retry shortly
    if (_currentClientId == null) {
      Future.delayed(const Duration(milliseconds: 500), () {
        if (_isConnected) _loadSessionInfo();
      });
      return;
    }

    try {
      await _sendCommand('get_session_info', clientId: _currentClientId);
    } catch (e) {
      // Ignore errors
    }
  }

  // Fetch chat history
  // In relay mode, passing relaySessionId returns only the current relay session's history
  Future<void> _loadChatHistory({String? sessionId, int limit = 50}) async {
    if (!_isConnected) return;

    try {
      await _sendCommand('get_chat_history',
          clientId: _currentClientId,
          sessionId: sessionId ?? _currentCursorSessionId,
          relaySessionId: _sessionId, // relay mode: current session only
          limit: limit);
    } catch (e) {
      // Ignore errors
    }
  }

  /// Remove chat messages only (keeps system/log messages); used to show just the current session.
  void _clearConversationMessages() {
    _messages.removeWhere((m) {
      switch (m.type) {
        case MessageType.userPrompt:
        case MessageType.chatResponse:
        case MessageType.chatResponseHeader:
        case MessageType.chatResponseDivider:
        case MessageType.chatResponseChunk:
        case MessageType.chatResponseComplete:
          return true;
        default:
          return false;
      }
    });
  }

  /// Apply get_chat_history entries to the main message list (_messages).
  /// With [skipIfExists], entries whose userMessage is already present are skipped.
  void _applyChatHistoryToMessages(List<Map<String, dynamic>> entries,
      {bool skipIfExists = false, bool replaceConversation = false}) {
    if (replaceConversation) _clearConversationMessages();
    if (entries.isEmpty) return;
    final oldestFirst = List<Map<String, dynamic>>.from(entries.reversed);
    for (final entry in oldestFirst) {
      final userMsg = entry['userMessage'] as String? ?? '';
      final assistantMsg = entry['assistantResponse'] as String? ?? '';
      if (skipIfExists &&
          _messages.any(
              (m) => m.type == MessageType.userPrompt && m.text == userMsg)) {
        continue;
      }
      final agentMode = entry['agentMode'] as String?;
      _messages.add(MessageItem(userMsg,
          type: MessageType.userPrompt, agentMode: agentMode));
      _messages.add(MessageItem('', type: MessageType.chatResponseDivider));
      _messages.add(MessageItem('🤖 Cursor AI Response',
          type: MessageType.chatResponseHeader));
      _messages.add(MessageItem(assistantMsg, type: MessageType.chatResponse));
      _messages.add(MessageItem('', type: MessageType.chatResponseDivider));
    }
  }

  @override
  void dispose() {
    _scrollController.removeListener(_updateScrollButtonVisibility);
    WidgetsBinding.instance.removeObserver(this);
    AppSettings().removeListener(_onAppSettingsChanged);
    _conn.removeListener(_onConnectionChanged);
    _conn.dispose();
    _chats.dispose();
    _commandController.dispose();
    _sessionIdController.dispose();
    _localIpController.dispose();
    _localPortController.dispose();
    _scrollController.dispose();
    _sessionIdFocusNode.dispose();
    _localIpFocusNode.dispose();
    _commandFocusNode.dispose();
    super.dispose();
  }

  /// Message list (filtered and searched), shared by the compact and full views.
  Widget _buildMessageList() {
    if (_displayMessages.isEmpty && !_isWaitingForResponse) {
      final isSearchActive = _searchQuery.trim().isNotEmpty;
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              _messages.isEmpty
                  ? Icons.chat_bubble_outline
                  : (isSearchActive ? Icons.search_off : Icons.filter_alt),
              size: 64,
              color: Theme.of(context)
                  .colorScheme
                  .onSurfaceVariant
                  .withValues(alpha: 0.4),
            ),
            const SizedBox(height: 16),
            Text(
              isSearchActive ? 'No results found' : 'No messages',
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
                fontSize: 15,
                fontWeight: FontWeight.w500,
              ),
            ),
            if (_messages.isEmpty) ...[
              const SizedBox(height: 8),
              Text(
                'Enter a prompt to get started',
                style: TextStyle(
                  color: Theme.of(context)
                      .colorScheme
                      .onSurfaceVariant
                      .withValues(alpha: 0.7),
                  fontSize: 13,
                ),
              ),
            ],
          ],
        ),
      );
    }
    return ListView.builder(
      controller: _scrollController,
      itemCount: _displayMessages.length + (_isWaitingForResponse ? 1 : 0),
      padding: const EdgeInsets.symmetric(vertical: 4),
      itemBuilder: (context, index) {
        if (index == _displayMessages.length && _isWaitingForResponse) {
          return Container(
            margin: const EdgeInsets.symmetric(horizontal: 8.0, vertical: 8.0),
            padding: const EdgeInsets.all(16.0),
            decoration: BoxDecoration(
              color: Theme.of(context)
                  .colorScheme
                  .surfaceContainerHighest
                  .withValues(alpha: 0.5),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    valueColor: AlwaysStoppedAnimation<Color>(
                      Theme.of(context).colorScheme.primary,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Text(
                  'Waiting for response…',
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w500,
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          );
        }
        final message = _displayMessages[index];
        return GestureDetector(
          onLongPress: () {
            Clipboard.setData(ClipboardData(text: message.text));
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(
                content: Text('Message copied to clipboard'),
                duration: Duration(seconds: 1),
              ),
            );
          },
          child: _buildMessageItem(message),
        );
      },
    );
  }

  void _scrollToTop() {
    if (!_scrollController.hasClients) return;
    _scrollController.animateTo(
      0,
      duration: const Duration(milliseconds: 300),
      curve: Curves.easeOut,
    );
  }

  /// Message list plus scroll-to-top/bottom buttons, each shown only when that direction can scroll.
  Widget _buildMessageListWithScrollButtons() {
    WidgetsBinding.instance
        .addPostFrameCallback((_) => _updateScrollButtonVisibility());
    return Stack(
      children: [
        _buildMessageList(),
        // Scroll to top: top right, only when scrollable up
        if (_canScrollUp)
          Positioned(
            top: 8,
            right: 8,
            child: Tooltip(
              message: 'Scroll to top',
              child: Material(
                elevation: 2,
                borderRadius: BorderRadius.circular(24),
                color: Theme.of(context).colorScheme.surfaceContainerHighest,
                child: InkWell(
                  borderRadius: BorderRadius.circular(24),
                  onTap: _scrollToTop,
                  child: const Padding(
                    padding: EdgeInsets.all(10),
                    child: Icon(Icons.arrow_upward, size: 22),
                  ),
                ),
              ),
            ),
          ),
        // Scroll to bottom: bottom right, only when scrollable down
        if (_canScrollDown)
          Positioned(
            bottom: 8,
            right: 8,
            child: Tooltip(
              message: 'Scroll to bottom',
              child: Material(
                elevation: 2,
                borderRadius: BorderRadius.circular(24),
                color: Theme.of(context).colorScheme.surfaceContainerHighest,
                child: InkWell(
                  borderRadius: BorderRadius.circular(24),
                  onTap: _scrollToBottom,
                  child: const Padding(
                    padding: EdgeInsets.all(10),
                    child: Icon(Icons.arrow_downward, size: 22),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }

  /// Compact view: large message area + single-line prompt (the app bar icon returns to the full view).
  Widget _buildCompactBody() {
    return Column(
      children: [
        Expanded(child: _buildMessageListWithScrollButtons()),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surface,
            border: Border(
              top: BorderSide(
                color: Theme.of(context).colorScheme.outline.withValues(alpha: 0.2),
              ),
            ),
          ),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _commandController,
                  focusNode: _commandFocusNode,
                  maxLines: 1,
                  textInputAction: TextInputAction.send,
                  decoration: InputDecoration(
                    hintText: 'Enter a prompt…',
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(
                        horizontal: 12, vertical: 10),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(24),
                    ),
                  ),
                  onSubmitted: (value) {
                    final text = value.trim();
                    if (text.isEmpty ||
                        !_isConnected ||
                        _isWaitingForResponse) {
                      return;
                    }
                    _submitPromptToAgent(text);
                    _clearCommandInput();
                  },
                ),
              ),
              const SizedBox(width: 8),
              IconButton.filled(
                onPressed: () {
                  final text = _commandController.text.trim();
                  if (text.isEmpty || !_isConnected || _isWaitingForResponse) {
                    return;
                  }
                  _submitPromptToAgent(text);
                  _clearCommandInput();
                },
                icon: const Icon(Icons.send),
                tooltip: 'Send',
              ),
            ],
          ),
        ),
      ],
    );
  }

  /// Spacious Local / Tunnel / Relay landing when offline.
  Widget _buildConnectionLanding() {
    return ConnectionLandingPage(
      connectionType: _connectionType,
      onTypeChanged: (t) {
        setState(() => _connectionType = t);
        if (t == ConnectionType.tunnel &&
            (_localPortController.text.trim().isEmpty ||
                _localPortController.text.trim() == '8766')) {
          _localPortController.text = '443';
        } else if (t == ConnectionType.local &&
            _localPortController.text.trim() == '443') {
          _localPortController.text = '8766';
        }
        _saveConnectionSettings();
      },
      hostController: _localIpController,
      portController: _localPortController,
      sessionIdController: _sessionIdController,
      hostFocus: _localIpFocusNode,
      sessionFocus: _sessionIdFocusNode,
      connecting: _isConnecting,
      reconnecting: _isReconnecting,
      error: _lastConnectionError,
      recent: AppSettings().connectionHistory,
      onConnect: _connect,
      onSelectRecent: _connectFromHistory,
      onDeleteRecent: (item) async {
        await AppSettings().removeConnectionHistory(item);
        if (mounted) setState(() {});
      },
      onClearRecent: () async {
        await AppSettings().clearConnectionHistory();
        if (mounted) setState(() {});
      },
      onHostChanged: (_) => _saveConnectionSettings(),
      onPortChanged: (_) => _saveConnectionSettings(),
      onRetry: () {
        _stopReconnect();
        _connect();
      },
      onUseLocal: () {
        setState(() => _connectionType = ConnectionType.local);
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final narrow = MediaQuery.sizeOf(context).width < 720;
    return Scaffold(
      backgroundColor: Cr.bg,
      appBar: AppBar(
        toolbarHeight: 56,
        titleSpacing: 16,
        title: const CrBrandMark(),
        actions: [
          if (_isConnected) ...[
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: CrModeSwitch(
                value: _selectedAgentBackend,
                compact: narrow,
                onChanged: (v) {
                  setState(() => _selectedAgentBackend = v);
                  if (v == 'cdp') _refreshAgents();
                },
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: CrStatusChip(
                ok: _isConnected,
                busy: _isWaitingForResponse || _isConnecting || _isReconnecting,
                label: _isWaitingForResponse
                    ? 'Working'
                    : (_connectionType == ConnectionType.local
                        ? 'Local'
                        : (_connectionType == ConnectionType.tunnel
                            ? 'Tunnel'
                            : 'Relay')),
              ),
            ),
            if (_selectedAgentBackend == 'cdp')
              IconButton(
                icon: Icon(_conn.relaySession != null ? Icons.logout_rounded : Icons.link_off_rounded, size: 20),
                tooltip: _conn.relaySession != null ? 'Log out' : 'Disconnect',
                onPressed: _disconnect,
              )
            else
              IconButton(
                icon: Icon(
                  _isCompactView
                      ? Icons.fullscreen_rounded
                      : Icons.view_agenda_outlined,
                  size: 20,
                ),
                tooltip: _isCompactView ? 'Full view' : 'Focus mode',
                onPressed: () {
                  setState(() => _isCompactView = !_isCompactView);
                },
              ),
          ] else
            const Padding(
              padding: EdgeInsets.only(right: 8),
              child: CrStatusChip(ok: false, label: 'Offline'),
            ),
          IconButton(
            icon: const Icon(Icons.settings_outlined, size: 20),
            tooltip: 'Settings',
            onPressed: () {
              Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (context) => SettingsPage(
                    relaySession: _conn.relaySession,
                    onLogOut: _conn.relaySession != null ? _confirmLogOut : null,
                  ),
                ),
              );
            },
          ),
          const SizedBox(width: 6),
        ],
        bottom: _showSession && !_isConnected
            ? PreferredSize(
                preferredSize: const Size.fromHeight(29),
                child: Container(
                  height: 29,
                  color: Cr.surfaceHigh,
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  child: Row(children: [
                    const SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 2, color: Cr.warning)),
                    const SizedBox(width: 8),
                    Text(_restoringLogin ? 'Connecting…' : 'Reconnecting…',
                        style: const TextStyle(color: Cr.warning, fontSize: 13)),
                  ]),
                ),
              )
            : PreferredSize(
                preferredSize: const Size.fromHeight(1),
                child: Container(height: 1, color: Cr.borderSubtle),
              ),
      ),
      body: SafeArea(
        child: !_showSession
          ? _buildConnectionLanding()
          : _selectedAgentBackend == 'cdp'
          ? Listener(
              onPointerDown: (_) => _conn.markActive(),
              child: AgentsShell(store: _chats, onLogOut: _conn.relaySession != null ? _confirmLogOut : null),
            )
          : _isCompactView
          ? _buildCompactBody()
          : LayoutBuilder(
              builder: (context, bodyConstraints) {
                final connectionMaxHeight = bodyConstraints.maxHeight * 0.42;
                return Column(
              children: [
                // Connection status and settings card (capped so Messages always fits)
                ConstrainedBox(
                  constraints: BoxConstraints(maxHeight: connectionMaxHeight),
                  child: SingleChildScrollView(
                    child: Container(
                  margin: const EdgeInsets.fromLTRB(12, 12, 12, 4),
                  decoration: BoxDecoration(
                    color: Cr.surface,
                    borderRadius: BorderRadius.circular(Cr.radiusLg),
                    border: Border.all(color: Cr.borderSubtle),
                  ),
                  child: Theme(
                    data: Theme.of(context).copyWith(
                      dividerColor: Colors.transparent,
                    ),
                    child: ExpansionTile(
                      controller: _expansionTileController,
                      tilePadding: const EdgeInsets.symmetric(
                          horizontal: 14, vertical: 4),
                      childrenPadding: EdgeInsets.zero,
                      leading: Semantics(
                        label: _connectionStatusLabel,
                        liveRegion: true,
                        child: Container(
                          padding: const EdgeInsets.all(8),
                          decoration: BoxDecoration(
                            color: _isConnected
                                ? Cr.success.withValues(alpha: 0.15)
                                : (_isConnecting || _isReconnecting)
                                    ? Cr.warning.withValues(alpha: 0.15)
                                    : Cr.surfaceHigh,
                            shape: BoxShape.circle,
                          ),
                          child: (_isConnecting || _isReconnecting) &&
                                  !_isConnected
                              ? const SizedBox(
                                  width: 20,
                                  height: 20,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    valueColor: AlwaysStoppedAnimation<Color>(
                                      Cr.warning,
                                    ),
                                  ),
                                )
                              : Icon(
                                  _isConnected
                                      ? Icons.cloud_done_rounded
                                      : Icons.cloud_off_rounded,
                                  color: _isConnected
                                      ? Cr.success
                                      : Cr.textFaint,
                                  size: 20,
                                ),
                        ),
                      ),
                      title: Text(
                        _connectionStatusLabel,
                        style: TextStyle(
                          fontWeight: FontWeight.w600,
                          color: _isConnected
                              ? Cr.success
                              : (_isConnecting || _isReconnecting)
                                  ? Cr.warning
                                  : Cr.text,
                        ),
                      ),
                      subtitle: Text(
                        _isConnected
                            ? (_connectionType == ConnectionType.local
                                ? 'Local Server'
                                : (_sessionId != null
                                    ? 'Relay · Session $_sessionId'
                                    : 'Relay Server'))
                            : (_isConnecting
                                ? 'Establishing connection…'
                                : (_isReconnecting
                                    ? 'Retrying connection…'
                                    : 'Local or Relay — connect to get started')),
                        style: const TextStyle(
                          fontSize: 12,
                          color: Cr.textSecondary,
                        ),
                      ),
                      initiallyExpanded: !_isConnected, // expand when not connected
                      children: [
                        Padding(
                          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              if (!_isConnected) ...[
                                Container(
                                  padding: const EdgeInsets.all(14),
                                  margin: const EdgeInsets.only(bottom: 14),
                                  decoration: BoxDecoration(
                                    gradient: const LinearGradient(
                                      begin: Alignment.topLeft,
                                      end: Alignment.bottomRight,
                                      colors: [
                                        Cr.accentSoft,
                                        Cr.surfaceHigh,
                                      ],
                                    ),
                                    borderRadius:
                                        BorderRadius.circular(Cr.radiusMd),
                                    border: Border.all(color: Cr.border),
                                  ),
                                  child: const Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        'Control Cursor from anywhere',
                                        style: TextStyle(
                                          color: Cr.text,
                                          fontSize: 15,
                                          fontWeight: FontWeight.w700,
                                          letterSpacing: -0.2,
                                        ),
                                      ),
                                      SizedBox(height: 4),
                                      Text(
                                        'Connect to your Mac, then use CLI Agent or live Existing Agents — same workspace, phone or desktop.',
                                        style: TextStyle(
                                          color: Cr.textSecondary,
                                          fontSize: 12.5,
                                          height: 1.4,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                              // Connection type selector
                              const CrSectionLabel('Connection type'),
                              const SizedBox(height: 10),
                              SizedBox(
                                width: double.infinity,
                                child: SegmentedButton<ConnectionType>(
                                  showSelectedIcon: false,
                                  style: const ButtonStyle(
                                    visualDensity: VisualDensity.compact,
                                    tapTargetSize:
                                        MaterialTapTargetSize.shrinkWrap,
                                  ),
                                  segments: const [
                                    ButtonSegment<ConnectionType>(
                                      value: ConnectionType.local,
                                      label: Text('Local',
                                          overflow: TextOverflow.ellipsis),
                                      icon: Icon(Icons.computer, size: 18),
                                    ),
                                    ButtonSegment<ConnectionType>(
                                      value: ConnectionType.relay,
                                      label: Text('Relay',
                                          overflow: TextOverflow.ellipsis),
                                      icon: Icon(Icons.cloud, size: 18),
                                    ),
                                  ],
                                  selected: {_connectionType},
                                  onSelectionChanged: _isConnected
                                      ? null
                                      : (Set<ConnectionType> newSelection) {
                                          setState(() {
                                            _connectionType =
                                                newSelection.first;
                                          });
                                        },
                                ),
                              ),
                              const SizedBox(height: 4),
                              Text(
                                _connectionType == ConnectionType.local
                                    ? 'Local Server — connect over your Wi‑Fi'
                                    : 'Relay Server — connect with a Session ID',
                                style: TextStyle(
                                  fontSize: 11,
                                  color: Theme.of(context)
                                      .colorScheme
                                      .onSurfaceVariant,
                                ),
                              ),
                              const SizedBox(height: 16),
                              // Local server connection UI
                              if (_connectionType == ConnectionType.local) ...[
                                TextField(
                                  controller: _localIpController,
                                  focusNode: _localIpFocusNode,
                                  decoration: const InputDecoration(
                                    labelText:
                                        'PC hostname or IP (Cursor extension)',
                                    hintText: '192.168.1.10',
                                    border: OutlineInputBorder(),
                                    isDense: true,
                                    contentPadding: EdgeInsets.all(12),
                                    prefixIcon: Icon(Icons.computer),
                                    helperText:
                                        'Same Wi-Fi as your Mac. Last address is restored automatically.',
                                  ),
                                  enabled: !_isConnected && !_isConnecting,
                                  keyboardType: TextInputType.url,
                                  autocorrect: false,
                                  enableSuggestions: false,
                                  textInputAction: TextInputAction.next,
                                  onSubmitted: (value) {
                                    if (!_isConnected) {
                                      _connect();
                                    }
                                  },
                                  onChanged: (value) {
                                    if (value.trim().isNotEmpty) {
                                      _saveConnectionSettings();
                                    }
                                  },
                                ),
                                const SizedBox(height: 8),
                                TextField(
                                  controller: _localPortController,
                                  decoration: const InputDecoration(
                                    labelText: 'Port',
                                    hintText: '8766',
                                    border: OutlineInputBorder(),
                                    isDense: true,
                                    contentPadding: EdgeInsets.all(12),
                                    prefixIcon: Icon(Icons.numbers),
                                  ),
                                  enabled: !_isConnected && !_isConnecting,
                                  keyboardType: TextInputType.number,
                                  textInputAction: TextInputAction.done,
                                  onSubmitted: (value) {
                                    if (!_isConnected && !_isConnecting) {
                                      _connect();
                                    }
                                  },
                                  onChanged: (value) {
                                    if (value.trim().isNotEmpty) {
                                      _saveConnectionSettings();
                                    }
                                  },
                                ),
                                const SizedBox(height: 8),
                                Container(
                                  padding: const EdgeInsets.all(12),
                                  decoration: BoxDecoration(
                                    color: Theme.of(context)
                                        .colorScheme
                                        .tertiaryContainer
                                        .withValues(alpha: 0.5),
                                    borderRadius: BorderRadius.circular(8),
                                    border: Border.all(
                                      color: Theme.of(context)
                                          .colorScheme
                                          .tertiary
                                          .withValues(alpha: 0.3),
                                      width: 1,
                                    ),
                                  ),
                                  child: Row(
                                    children: [
                                      Icon(Icons.info_outline,
                                          size: 18,
                                          color: Theme.of(context)
                                              .colorScheme
                                              .tertiary),
                                      const SizedBox(width: 8),
                                      Expanded(
                                        child: Text(
                                          'Your phone and Mac must be on the same network (default port 8766). You can also paste a full ws:// or wss:// URL in the host field.',
                                          style: TextStyle(
                                            fontSize: 12,
                                            fontWeight: FontWeight.w500,
                                            color: Theme.of(context)
                                                .colorScheme
                                                .onSurface,
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ] else ...[
                                // Relay server connection UI
                                TextField(
                                  controller: _sessionIdController,
                                  focusNode: _sessionIdFocusNode,
                                  decoration: const InputDecoration(
                                    labelText: 'Session ID (from Cursor extension)',
                                    hintText: 'ABC123',
                                    border: OutlineInputBorder(),
                                    isDense: true,
                                    contentPadding: EdgeInsets.all(12),
                                    prefixIcon: Icon(Icons.cloud),
                                    helperText:
                                        'Enter a Session ID from Cursor, or leave blank and tap Generate & Connect',
                                  ),
                                  enabled: !_isConnected && !_isConnecting,
                                  keyboardType: TextInputType.text,
                                  textCapitalization:
                                      TextCapitalization.characters,
                                  textInputAction: TextInputAction.done,
                                  onSubmitted: (value) {
                                    if (!_isConnected && !_isConnecting) {
                                      _connect();
                                    }
                                  },
                                ),
                                const SizedBox(height: 8),
                                Container(
                                  padding: const EdgeInsets.all(12),
                                  decoration: BoxDecoration(
                                    color: Theme.of(context)
                                        .colorScheme
                                        .primaryContainer
                                        .withValues(alpha: 0.5),
                                    borderRadius: BorderRadius.circular(8),
                                    border: Border.all(
                                      color: Theme.of(context)
                                          .colorScheme
                                          .primary
                                          .withValues(alpha: 0.2),
                                      width: 1,
                                    ),
                                  ),
                                  child: Row(
                                    children: [
                                      Icon(Icons.info_outline,
                                          size: 18,
                                          color: Theme.of(context)
                                              .colorScheme
                                              .primary),
                                      const SizedBox(width: 8),
                                      Expanded(
                                        child: Text(
                                          'Click the status bar in Cursor to generate and connect a Session ID, then enter the same ID here.',
                                          style: TextStyle(
                                            fontSize: 12,
                                            fontWeight: FontWeight.w500,
                                            color: Theme.of(context)
                                                .colorScheme
                                                .onSurface,
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                              const SizedBox(height: 12),
                              // Recent connections
                              if (!_isConnected &&
                                  AppSettings()
                                      .connectionHistory
                                      .isNotEmpty) ...[
                                Row(
                                  mainAxisAlignment:
                                      MainAxisAlignment.spaceBetween,
                                  children: [
                                    Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          'Recent Connections',
                                          style: TextStyle(
                                            fontSize: 14,
                                            fontWeight: FontWeight.w600,
                                            color: Theme.of(context)
                                                .colorScheme
                                                .onSurface,
                                          ),
                                        ),
                                        Text(
                                          'Tap to reconnect',
                                          style: TextStyle(
                                            fontSize: 11,
                                            color: Theme.of(context)
                                                .colorScheme
                                                .onSurfaceVariant,
                                          ),
                                        ),
                                      ],
                                    ),
                                    TextButton.icon(
                                      onPressed: () async {
                                        final confirm = await showDialog<bool>(
                                          context: context,
                                          builder: (ctx) => AlertDialog(
                                            title: const Text('Clear All'),
                                            content: const Text(
                                              'Remove all recent connections?',
                                            ),
                                            actions: [
                                              TextButton(
                                                onPressed: () =>
                                                    Navigator.of(ctx)
                                                        .pop(false),
                                                child: const Text('Cancel'),
                                              ),
                                              TextButton(
                                                onPressed: () =>
                                                    Navigator.of(ctx).pop(true),
                                                child: const Text('Clear All'),
                                              ),
                                            ],
                                          ),
                                        );
                                        if (confirm == true) {
                                          await AppSettings()
                                              .clearConnectionHistory();
                                        }
                                      },
                                      icon: const Icon(Icons.delete_sweep,
                                          size: 18),
                                      label: const Text('Clear All'),
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 8),
                                Container(
                                  decoration: BoxDecoration(
                                    color: Theme.of(context)
                                        .colorScheme
                                        .surfaceContainerHighest
                                        .withValues(alpha: 0.5),
                                    borderRadius: BorderRadius.circular(12),
                                    border: Border.all(
                                      color: Theme.of(context)
                                          .colorScheme
                                          .outline
                                          .withValues(alpha: 0.2),
                                      width: 1,
                                    ),
                                  ),
                                  child: Column(
                                    children: AppSettings()
                                        .connectionHistory
                                        .asMap()
                                        .entries
                                        .map((entry) {
                                      final index = entry.key;
                                      final item = entry.value;
                                      final isLast = index ==
                                          AppSettings()
                                                  .connectionHistory
                                                  .length -
                                              1;
                                      return Column(
                                        children: [
                                          Tooltip(
                                            message: 'Tap to reconnect',
                                            child: InkWell(
                                              onTap: () =>
                                                  _connectFromHistory(item),
                                              borderRadius:
                                                  BorderRadius.vertical(
                                                top: index == 0
                                                    ? const Radius.circular(12)
                                                    : Radius.zero,
                                                bottom: isLast
                                                    ? const Radius.circular(12)
                                                    : Radius.zero,
                                              ),
                                              child: Padding(
                                                padding:
                                                    const EdgeInsets.symmetric(
                                                        horizontal: 12,
                                                        vertical: 10),
                                                child: Row(
                                                  children: [
                                                    Container(
                                                      padding:
                                                          const EdgeInsets.all(
                                                              6),
                                                      decoration: BoxDecoration(
                                                        color: item.type ==
                                                                ConnectionType
                                                                    .local
                                                            ? Theme.of(context)
                                                                .colorScheme
                                                                .secondaryContainer
                                                            : Theme.of(context)
                                                                .colorScheme
                                                                .primaryContainer,
                                                        borderRadius:
                                                            BorderRadius
                                                                .circular(6),
                                                      ),
                                                      child: Icon(
                                                        item.type ==
                                                                ConnectionType
                                                                    .local
                                                            ? Icons.computer
                                                            : Icons.cloud,
                                                        size: 14,
                                                        color: item.type ==
                                                                ConnectionType
                                                                    .local
                                                            ? Theme.of(context)
                                                                .colorScheme
                                                                .onSecondaryContainer
                                                            : Theme.of(context)
                                                                .colorScheme
                                                                .onPrimaryContainer,
                                                      ),
                                                    ),
                                                    const SizedBox(width: 10),
                                                    Expanded(
                                                      child: Column(
                                                        crossAxisAlignment:
                                                            CrossAxisAlignment
                                                                .start,
                                                        children: [
                                                          Text(
                                                            item.displayText,
                                                            style: TextStyle(
                                                              fontSize: 13,
                                                              fontWeight:
                                                                  FontWeight
                                                                      .w500,
                                                              color: Theme.of(
                                                                      context)
                                                                  .colorScheme
                                                                  .onSurface,
                                                              fontFamily:
                                                                  'monospace',
                                                            ),
                                                          ),
                                                          Text(
                                                            item.relativeTime,
                                                            style: TextStyle(
                                                              fontSize: 11,
                                                              color: Theme.of(
                                                                      context)
                                                                  .colorScheme
                                                                  .onSurfaceVariant,
                                                            ),
                                                          ),
                                                        ],
                                                      ),
                                                    ),
                                                    Icon(
                                                      Icons.settings_ethernet,
                                                      size: 20,
                                                      color: Theme.of(context)
                                                          .colorScheme
                                                          .primary,
                                                    ),
                                                    const SizedBox(width: 4),
                                                    IconButton(
                                                      icon: Icon(
                                                        Icons.delete_outline,
                                                        size: 20,
                                                        color: Theme.of(context)
                                                            .colorScheme
                                                            .error,
                                                      ),
                                                      onPressed: () async {
                                                        final confirm =
                                                            await showDialog<
                                                                bool>(
                                                          context: context,
                                                          builder: (ctx) =>
                                                              AlertDialog(
                                                            title: const Text(
                                                                'Remove Connection'),
                                                            content: Text(
                                                              'Remove ${item.displayText} from history?',
                                                            ),
                                                            actions: [
                                                              TextButton(
                                                                onPressed: () =>
                                                                    Navigator.of(
                                                                            ctx)
                                                                        .pop(
                                                                            false),
                                                                child:
                                                                    const Text(
                                                                        'Cancel'),
                                                              ),
                                                              TextButton(
                                                                onPressed: () =>
                                                                    Navigator.of(
                                                                            ctx)
                                                                        .pop(
                                                                            true),
                                                                child:
                                                                    const Text(
                                                                        'Remove'),
                                                              ),
                                                            ],
                                                          ),
                                                        );
                                                        if (confirm == true) {
                                                          await AppSettings()
                                                              .removeConnectionHistory(
                                                                  item);
                                                        }
                                                      },
                                                      padding: EdgeInsets.zero,
                                                      constraints:
                                                          const BoxConstraints(
                                                              minWidth: 32,
                                                              minHeight: 32),
                                                    ),
                                                  ],
                                                ),
                                              ),
                                            ),
                                          ),
                                          if (!isLast)
                                            Divider(
                                              height: 1,
                                              indent: 12,
                                              endIndent: 12,
                                              color: Theme.of(context)
                                                  .colorScheme
                                                  .outline
                                                  .withValues(alpha: 0.2),
                                            ),
                                        ],
                                      );
                                    }).toList(),
                                  ),
                                ),
                                const SizedBox(height: 16),
                              ],
                              // Reconnecting status
                              if (_isReconnecting) ...[
                                Container(
                                  padding: const EdgeInsets.all(12),
                                  decoration: BoxDecoration(
                                    color: Theme.of(context)
                                        .colorScheme
                                        .tertiaryContainer
                                        .withValues(alpha: 0.5),
                                    borderRadius: BorderRadius.circular(8),
                                    border: Border.all(
                                      color: Theme.of(context)
                                          .colorScheme
                                          .tertiary
                                          .withValues(alpha: 0.3),
                                      width: 1,
                                    ),
                                  ),
                                  child: Row(
                                    children: [
                                      SizedBox(
                                        width: 16,
                                        height: 16,
                                        child: CircularProgressIndicator(
                                          strokeWidth: 2,
                                          valueColor:
                                              AlwaysStoppedAnimation<Color>(
                                            Theme.of(context)
                                                .colorScheme
                                                .tertiary,
                                          ),
                                        ),
                                      ),
                                      const SizedBox(width: 12),
                                      Expanded(
                                        child: Text(
                                          'Reconnecting… (attempt $_reconnectAttempts)',
                                          style: TextStyle(
                                            fontSize: 12,
                                            fontWeight: FontWeight.w500,
                                            color: Theme.of(context)
                                                .colorScheme
                                                .onSurface,
                                          ),
                                        ),
                                      ),
                                      TextButton(
                                        onPressed: _stopReconnect,
                                        child: const Text('Cancel',
                                            style: TextStyle(fontSize: 12)),
                                      ),
                                    ],
                                  ),
                                ),
                                const SizedBox(height: 8),
                              ],
                              // Connection error
                              if (_lastConnectionError != null &&
                                  !_isConnected &&
                                  !_isReconnecting) ...[
                                Container(
                                  padding: const EdgeInsets.all(12),
                                  decoration: BoxDecoration(
                                    color: Theme.of(context)
                                        .colorScheme
                                        .errorContainer
                                        .withValues(alpha: 0.3),
                                    borderRadius: BorderRadius.circular(12),
                                    border: Border.all(
                                      color: Theme.of(context)
                                          .colorScheme
                                          .error
                                          .withValues(alpha: 0.2),
                                      width: 1,
                                    ),
                                  ),
                                  child: Row(
                                    children: [
                                      Icon(
                                        Icons.error_outline,
                                        size: 20,
                                        color:
                                            Theme.of(context).colorScheme.error,
                                      ),
                                      const SizedBox(width: 12),
                                      Expanded(
                                        child: Text(
                                          'Connection error: ${_lastConnectionError!.length > 80 ? '${_lastConnectionError!.substring(0, 80)}…' : _lastConnectionError}',
                                          style: TextStyle(
                                            fontSize: 13,
                                            fontWeight: FontWeight.w500,
                                            color: Theme.of(context)
                                                .colorScheme
                                                .onErrorContainer,
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                                const SizedBox(height: 12),
                              ],
                              LayoutBuilder(
                                builder: (context, btnConstraints) {
                                  final stackButtons =
                                      btnConstraints.maxWidth < 420;
                                  final connectLabel = _isConnecting
                                      ? 'Connecting…'
                                      : (_connectionType ==
                                              ConnectionType.local
                                          ? 'Connect'
                                          : (_sessionIdController.text
                                                  .trim()
                                                  .isEmpty
                                              ? 'Generate & Connect'
                                              : 'Connect'));
                                  final connectBtn = FilledButton.icon(
                                    onPressed: _isConnected ||
                                            _isReconnecting ||
                                            _isConnecting
                                        ? null
                                        : _connect,
                                    icon: Icon(
                                      _connectionType == ConnectionType.local
                                          ? Icons.computer
                                          : Icons.cloud,
                                      size: 18,
                                    ),
                                    label: Text(
                                      connectLabel,
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  );
                                  final retryBtn = OutlinedButton.icon(
                                    onPressed: _isReconnecting
                                        ? null
                                        : _manualReconnect,
                                    icon: const Icon(Icons.refresh, size: 18),
                                    label: const Text('Retry'),
                                  );
                                  final disconnectBtn = OutlinedButton(
                                    onPressed:
                                        _isConnected ? _disconnect : null,
                                    child: const Text('Disconnect'),
                                  );
                                  final showRetry = !_isConnected &&
                                      _lastConnectionError != null;

                                  if (stackButtons) {
                                    return Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.stretch,
                                      children: [
                                        connectBtn,
                                        if (showRetry) ...[
                                          const SizedBox(height: 8),
                                          retryBtn,
                                        ],
                                        const SizedBox(height: 8),
                                        disconnectBtn,
                                      ],
                                    );
                                  }
                                  return Row(
                                    children: [
                                      Expanded(child: connectBtn),
                                      if (showRetry) ...[
                                        const SizedBox(width: 8),
                                        Expanded(child: retryBtn),
                                      ],
                                      const SizedBox(width: 8),
                                      Expanded(child: disconnectBtn),
                                    ],
                                  );
                                },
                              ),
                              // Connection status banner
                              if (_isConnected) ...[
                                const SizedBox(height: 12),
                                Container(
                                  padding: const EdgeInsets.all(12),
                                  decoration: BoxDecoration(
                                    color: Theme.of(context)
                                        .colorScheme
                                        .primaryContainer
                                        .withValues(alpha: 0.3),
                                    borderRadius: BorderRadius.circular(12),
                                    border: Border.all(
                                      color: Theme.of(context)
                                          .colorScheme
                                          .primary
                                          .withValues(alpha: 0.2),
                                      width: 1,
                                    ),
                                  ),
                                  child: Row(
                                    children: [
                                      Icon(
                                        Icons.check_circle,
                                        size: 20,
                                        color: Theme.of(context)
                                            .colorScheme
                                            .primary,
                                      ),
                                      const SizedBox(width: 12),
                                      Expanded(
                                        child: Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            Text(
                                              _connectionType ==
                                                      ConnectionType.local
                                                  ? 'Connected to Local Server'
                                                  : 'Connected via Relay Server',
                                              style: TextStyle(
                                                fontSize: 14,
                                                fontWeight: FontWeight.w600,
                                                color: Theme.of(context)
                                                    .colorScheme
                                                    .onSurface,
                                              ),
                                            ),
                                            if (_connectionType ==
                                                    ConnectionType.relay &&
                                                _sessionId != null) ...[
                                              const SizedBox(height: 4),
                                              Row(
                                                children: [
                                                  Expanded(
                                                    child: Text(
                                                      'Session ID: $_sessionId',
                                                      style: TextStyle(
                                                        fontSize: 12,
                                                        fontWeight:
                                                            FontWeight.w500,
                                                        color: Theme.of(context)
                                                            .colorScheme
                                                            .onSurfaceVariant,
                                                        fontFamily: 'monospace',
                                                      ),
                                                    ),
                                                  ),
                                                  IconButton(
                                                    icon: const Icon(Icons.copy,
                                                        size: 16),
                                                    padding: EdgeInsets.zero,
                                                    constraints:
                                                        const BoxConstraints(),
                                                    onPressed: () {
                                                      Clipboard.setData(
                                                          ClipboardData(
                                                              text:
                                                                  _sessionId!));
                                                      ScaffoldMessenger.of(
                                                              context)
                                                          .showSnackBar(
                                                        const SnackBar(
                                                          content: Text(
                                                              'Session ID copied to clipboard'),
                                                          duration: Duration(
                                                              seconds: 1),
                                                        ),
                                                      );
                                                    },
                                                  ),
                                                ],
                                              ),
                                            ],
                                          ],
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ] else if (!_isConnected && !_isReconnecting) ...[
                                const SizedBox(height: 12),
                                Container(
                                  padding: const EdgeInsets.all(12),
                                  decoration: BoxDecoration(
                                    color: Theme.of(context)
                                        .colorScheme
                                        .surfaceContainerHighest
                                        .withValues(alpha: 0.5),
                                    borderRadius: BorderRadius.circular(12),
                                    border: Border.all(
                                      color: Theme.of(context)
                                          .colorScheme
                                          .outline
                                          .withValues(alpha: 0.2),
                                      width: 1,
                                    ),
                                  ),
                                  child: Row(
                                    children: [
                                      Icon(
                                        Icons.cloud_off,
                                        size: 20,
                                        color: Theme.of(context)
                                            .colorScheme
                                            .onSurfaceVariant,
                                      ),
                                      const SizedBox(width: 12),
                                      Expanded(
                                        child: Text(
                                          'Not Connected',
                                          style: TextStyle(
                                            fontSize: 14,
                                            fontWeight: FontWeight.w500,
                                            color: Theme.of(context)
                                                .colorScheme
                                                .onSurfaceVariant,
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                ),
                ),
                // Messages log OR full Existing Agent control center
                Expanded(
                  child: _selectedAgentBackend == 'cdp' && _isConnected
                      ? Padding(
                          padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
                          child: ClipRRect(
                            borderRadius: BorderRadius.circular(Cr.radiusLg),
                            child: DecoratedBox(
                              decoration: BoxDecoration(
                                border: Border.all(color: Cr.borderSubtle),
                                borderRadius:
                                    BorderRadius.circular(Cr.radiusLg),
                              ),
                              child: AgentsShell(store: _chats, onLogOut: _conn.relaySession != null ? _confirmLogOut : null),
                            ),
                          ),
                        )
                      : Card(
                    margin: const EdgeInsets.all(8.0),
                    child: LayoutBuilder(
                      builder: (context, constraints) {
                        final showFilters = constraints.maxHeight >= 180;
                        final headerMax = (constraints.maxHeight * 0.45)
                            .clamp(36.0, 240.0);
                        return Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        // Messages header — capped + scrollable so list always fits
                        ConstrainedBox(
                          constraints: BoxConstraints(maxHeight: headerMax),
                          child: SingleChildScrollView(
                            child: Padding(
                          padding: EdgeInsets.all(showFilters ? 12.0 : 8.0),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Row(
                                mainAxisAlignment:
                                    MainAxisAlignment.spaceBetween,
                                children: [
                                  Row(
                                    children: [
                                      Icon(
                                        Icons.chat_bubble_outline,
                                        size: 20,
                                        color: Theme.of(context)
                                            .colorScheme
                                            .primary,
                                      ),
                                      const SizedBox(width: 8),
                                      Text(
                                        'Messages',
                                        style: TextStyle(
                                          fontSize: showFilters ? 18 : 16,
                                          fontWeight: FontWeight.w600,
                                          color: Theme.of(context)
                                              .colorScheme
                                              .onSurface,
                                        ),
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                              if (showFilters) ...[
                              const SizedBox(height: 8),
                              // Search scope + field (stacked to avoid horizontal overflow)
                              SizedBox(
                                width: double.infinity,
                                child: SegmentedButton<String>(
                                  showSelectedIcon: false,
                                  style: const ButtonStyle(
                                    visualDensity: VisualDensity.compact,
                                    tapTargetSize:
                                        MaterialTapTargetSize.shrinkWrap,
                                  ),
                                  segments: const [
                                    ButtonSegment<String>(
                                      value: _searchScopeAll,
                                      label: Text('All'),
                                      icon: Icon(Icons.chat, size: 14),
                                    ),
                                    ButtonSegment<String>(
                                      value: _searchScopeAnswerOnly,
                                      label: Text('Responses'),
                                      icon: Icon(Icons.smart_toy, size: 14),
                                    ),
                                  ],
                                  selected: {_searchScope},
                                  onSelectionChanged: (Set<String> s) {
                                    setState(() => _searchScope = s.first);
                                  },
                                ),
                              ),
                              const SizedBox(height: 8),
                              TextField(
                                onChanged: (v) =>
                                    setState(() => _searchQuery = v),
                                decoration: InputDecoration(
                                  hintText: 'Search messages',
                                  isDense: true,
                                  contentPadding:
                                      const EdgeInsets.symmetric(
                                          horizontal: 12, vertical: 8),
                                  prefixIcon:
                                      const Icon(Icons.search, size: 20),
                                  suffixIcon: _searchQuery.isNotEmpty
                                      ? IconButton(
                                          icon: const Icon(Icons.clear,
                                              size: 18),
                                          onPressed: () => setState(
                                              () => _searchQuery = ''),
                                        )
                                      : null,
                                  border: OutlineInputBorder(
                                    borderRadius: BorderRadius.circular(8),
                                  ),
                                ),
                              ),
                              const SizedBox(height: 8),
                              // Filter chips
                              Wrap(
                                spacing: 8.0,
                                runSpacing: 4.0,
                                children: [
                                  FilterChip(
                                    label: const Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Icon(Icons.smart_toy, size: 14),
                                        SizedBox(width: 4),
                                        Text('AI Response',
                                            style: TextStyle(fontSize: 12)),
                                      ],
                                    ),
                                    selected: _activeFilters[
                                            MessageFilter.aiResponse] ??
                                        true,
                                    selectedColor: Theme.of(context)
                                        .colorScheme
                                        .tertiaryContainer,
                                    checkmarkColor:
                                        Theme.of(context).colorScheme.tertiary,
                                    onSelected: (selected) {
                                      setState(() {
                                        _activeFilters[MessageFilter
                                            .aiResponse] = selected;
                                      });
                                    },
                                  ),
                                  FilterChip(
                                    label: const Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Icon(Icons.person, size: 14),
                                        SizedBox(width: 4),
                                        Text('User Prompt',
                                            style: TextStyle(fontSize: 12)),
                                      ],
                                    ),
                                    selected: _activeFilters[
                                            MessageFilter.userPrompt] ??
                                        true,
                                    selectedColor: Theme.of(context)
                                        .colorScheme
                                        .secondaryContainer,
                                    checkmarkColor:
                                        Theme.of(context).colorScheme.secondary,
                                    onSelected: (selected) {
                                      setState(() {
                                        _activeFilters[MessageFilter
                                            .userPrompt] = selected;
                                      });
                                    },
                                  ),
                                  FilterChip(
                                    label: const Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Icon(Icons.bug_report, size: 14),
                                        SizedBox(width: 4),
                                        Text('Logs',
                                            style: TextStyle(fontSize: 12)),
                                      ],
                                    ),
                                    selected:
                                        _activeFilters[MessageFilter.log] ??
                                            false,
                                    selectedColor:
                                        const Color(0xFFFFF3E0), // orange background
                                    checkmarkColor:
                                        const Color(0xFFFF9800), // orange
                                    onSelected: (selected) {
                                      setState(() {
                                        _activeFilters[MessageFilter.log] =
                                            selected;
                                        // Enabling the log filter turns on every level filter
                                        if (selected) {
                                          _logLevelFilters[LogLevel.error] =
                                              true;
                                          _logLevelFilters[LogLevel.warning] =
                                              true;
                                          _logLevelFilters[LogLevel.info] =
                                              true;
                                        }
                                      });
                                    },
                                  ),
                                  // Log level filters (only shown when the log filter is on)
                                  if (_activeFilters[MessageFilter.log] ??
                                      false) ...[
                                    const SizedBox(width: 4),
                                    Container(
                                      height: 24,
                                      width: 1,
                                      color: Theme.of(context)
                                          .colorScheme
                                          .outlineVariant,
                                    ),
                                    const SizedBox(width: 4),
                                    FilterChip(
                                      label: const Row(
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          Icon(Icons.error,
                                              size: 12,
                                              color: Color(0xFFDC3545)),
                                          SizedBox(width: 2),
                                          Text('Error',
                                              style: TextStyle(fontSize: 10)),
                                        ],
                                      ),
                                      visualDensity: VisualDensity.compact,
                                      selected:
                                          _logLevelFilters[LogLevel.error] ??
                                              true,
                                      selectedColor: const Color(0xFFFFEBEE),
                                      checkmarkColor: const Color(0xFFDC3545),
                                      onSelected: (selected) {
                                        setState(() {
                                          _logLevelFilters[LogLevel.error] =
                                              selected;
                                        });
                                      },
                                    ),
                                    FilterChip(
                                      label: const Row(
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          Icon(Icons.warning,
                                              size: 12,
                                              color: Color(0xFFFF9800)),
                                          SizedBox(width: 2),
                                          Text('Warn',
                                              style: TextStyle(fontSize: 10)),
                                        ],
                                      ),
                                      visualDensity: VisualDensity.compact,
                                      selected:
                                          _logLevelFilters[LogLevel.warning] ??
                                              true,
                                      selectedColor: const Color(0xFFFFF3E0),
                                      checkmarkColor: const Color(0xFFFF9800),
                                      onSelected: (selected) {
                                        setState(() {
                                          _logLevelFilters[LogLevel.warning] =
                                              selected;
                                        });
                                      },
                                    ),
                                    FilterChip(
                                      label: Row(
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          Icon(Icons.info,
                                              size: 12,
                                              color: Theme.of(context)
                                                  .colorScheme
                                                  .tertiary),
                                          const SizedBox(width: 2),
                                          const Text('Info',
                                              style: TextStyle(fontSize: 10)),
                                        ],
                                      ),
                                      visualDensity: VisualDensity.compact,
                                      selected:
                                          _logLevelFilters[LogLevel.info] ??
                                              true,
                                      selectedColor: Theme.of(context)
                                          .colorScheme
                                          .tertiaryContainer,
                                      checkmarkColor: Theme.of(context)
                                          .colorScheme
                                          .tertiary,
                                      onSelected: (selected) {
                                        setState(() {
                                          _logLevelFilters[LogLevel.info] =
                                              selected;
                                        });
                                      },
                                    ),
                                  ],
                                  FilterChip(
                                    label: const Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Icon(Icons.info_outline, size: 14),
                                        SizedBox(width: 4),
                                        Text('System',
                                            style: TextStyle(fontSize: 12)),
                                      ],
                                    ),
                                    selected:
                                        _activeFilters[MessageFilter.system] ??
                                            true,
                                    selectedColor: Theme.of(context)
                                        .colorScheme
                                        .surfaceContainerHighest,
                                    checkmarkColor: Theme.of(context)
                                        .colorScheme
                                        .onSurfaceVariant,
                                    onSelected: (selected) {
                                      setState(() {
                                        _activeFilters[MessageFilter.system] =
                                            selected;
                                      });
                                    },
                                  ),
                                ],
                              ),
                              ], // end if (showFilters)
                            ],
                          ),
                        ),
                          ),
                        ),
                        const Divider(height: 1),
                        Expanded(
                          child: _buildMessageListWithScrollButtons(),
                        ),
                      ],
                        );
                      },
                    ),
                  ),
                ),
                // Command input section
                if (_isConnected) ...[
                  const Divider(height: 1),
                  Card(
                    margin: const EdgeInsets.all(8.0),
                    child: Padding(
                      padding: const EdgeInsets.all(12.0),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          // Mode switch lives in the app bar; keep a short hint here.
                          if (_selectedAgentBackend == 'cdp') ...[
                            Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 12, vertical: 10),
                              decoration: BoxDecoration(
                                color: Cr.accentSoft,
                                borderRadius:
                                    BorderRadius.circular(Cr.radiusMd),
                                border: Border.all(color: Cr.border),
                              ),
                              child: const Row(
                                children: [
                                  Icon(Icons.auto_awesome_rounded,
                                      size: 16, color: Cr.accent),
                                  SizedBox(width: 10),
                                  Expanded(
                                    child: Text(
                                      'Agents mode — prompts go to the live Cursor Agent selected above, not a new CLI process.',
                                      style: TextStyle(
                                        fontSize: 12,
                                        color: Cr.textSecondary,
                                        height: 1.35,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                          if (_selectedAgentBackend == 'cli') ...[
                          const SizedBox(height: 10),
                          // Agent mode picker
                          Row(
                            children: [
                              Container(
                                padding: const EdgeInsets.all(6),
                                decoration: BoxDecoration(
                                  color: Theme.of(context)
                                      .colorScheme
                                      .primaryContainer,
                                  borderRadius: BorderRadius.circular(8),
                                ),
                                child: Icon(
                                  Icons.smart_toy,
                                  size: 18,
                                  color: Theme.of(context)
                                      .colorScheme
                                      .onPrimaryContainer,
                                ),
                              ),
                              const SizedBox(width: 12),
                              Text(
                                'Agent Mode',
                                style: TextStyle(
                                  fontSize: 14,
                                  fontWeight: FontWeight.w600,
                                  color:
                                      Theme.of(context).colorScheme.onSurface,
                                ),
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Container(
                                  padding: const EdgeInsets.symmetric(
                                      horizontal: 12, vertical: 4),
                                  decoration: BoxDecoration(
                                    color: Theme.of(context)
                                        .colorScheme
                                        .surfaceContainerHighest,
                                    borderRadius: BorderRadius.circular(12),
                                    border: Border.all(
                                      color: Theme.of(context)
                                          .colorScheme
                                          .outline
                                          .withValues(alpha: 0.2),
                                      width: 1,
                                    ),
                                  ),
                                  child: DropdownButton<String>(
                                    value: _selectedAgentMode,
                                    isExpanded: true,
                                    isDense: true,
                                    underline: Container(),
                                    style: TextStyle(
                                      fontSize: 13,
                                      color: Theme.of(context)
                                          .colorScheme
                                          .onSurface,
                                    ),
                                    dropdownColor:
                                        Theme.of(context).colorScheme.surface,
                                    icon: Icon(
                                      Icons.arrow_drop_down,
                                      color: Theme.of(context)
                                          .colorScheme
                                          .onSurfaceVariant,
                                    ),
                                    items: const [
                                      DropdownMenuItem(
                                        value: 'auto',
                                        child: Row(
                                          children: [
                                            Icon(Icons.auto_awesome, size: 16),
                                            SizedBox(width: 4),
                                            Text('Auto (auto-detect)',
                                                style: TextStyle(fontSize: 12)),
                                          ],
                                        ),
                                      ),
                                      DropdownMenuItem(
                                        value: 'agent',
                                        child: Row(
                                          children: [
                                            Icon(Icons.code, size: 16),
                                            SizedBox(width: 4),
                                            Text('Agent (code & edits)',
                                                style: TextStyle(fontSize: 12)),
                                          ],
                                        ),
                                      ),
                                      DropdownMenuItem(
                                        value: 'ask',
                                        child: Row(
                                          children: [
                                            Icon(Icons.help_outline, size: 16),
                                            SizedBox(width: 4),
                                            Text('Ask (questions & learning)',
                                                style: TextStyle(fontSize: 12)),
                                          ],
                                        ),
                                      ),
                                      DropdownMenuItem(
                                        value: 'plan',
                                        child: Row(
                                          children: [
                                            Icon(Icons.assignment, size: 16),
                                            SizedBox(width: 4),
                                            Text('Plan (planning & design)',
                                                style: TextStyle(fontSize: 12)),
                                          ],
                                        ),
                                      ),
                                      DropdownMenuItem(
                                        value: 'debug',
                                        child: Row(
                                          children: [
                                            Icon(Icons.bug_report, size: 16),
                                            SizedBox(width: 4),
                                            Text('Debug (bug fixes)',
                                                style: TextStyle(fontSize: 12)),
                                          ],
                                        ),
                                      ),
                                    ],
                                    onChanged: (value) {
                                      if (value != null) {
                                        setState(() {
                                          _selectedAgentMode = value;
                                          // A manual mode choice clears the auto-picked mode label
                                          if (value != 'auto') {
                                            _actualSelectedMode = null;
                                          }
                                        });
                                      }
                                    },
                                  ),
                                ),
                              ),
                            ],
                          ),
                          // Show the mode auto mode actually picked
                          if (_selectedAgentMode == 'auto' &&
                              _actualSelectedMode != null)
                            Padding(
                              padding:
                                  const EdgeInsets.only(top: 8.0, left: 42.0),
                              child: Container(
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 8, vertical: 4),
                                decoration: BoxDecoration(
                                  color: Theme.of(context)
                                      .colorScheme
                                      .primaryContainer
                                      .withValues(alpha: 0.3),
                                  borderRadius: BorderRadius.circular(8),
                                ),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Icon(
                                      Icons.info_outline,
                                      size: 14,
                                      color:
                                          Theme.of(context).colorScheme.primary,
                                    ),
                                    const SizedBox(width: 6),
                                    Text(
                                      'Active mode: ${_getModeDisplayName(_actualSelectedMode!)}',
                                      style: TextStyle(
                                        fontSize: 12,
                                        fontWeight: FontWeight.w500,
                                        color: Theme.of(context)
                                            .colorScheme
                                            .onPrimaryContainer,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          const SizedBox(height: 8),
                          // KeyboardListener: Enter sends. Reads from the controller, debounces, and re-clears a frame after sending to avoid IME double submits.
                          // (Focus with the same FocusNode is avoided because it trips a focus_manager assertion.)
                          KeyboardListener(
                            focusNode: FocusNode(),
                            onKeyEvent: (event) {
                              if (event is! KeyDownEvent ||
                                  event.logicalKey !=
                                      LogicalKeyboardKey.enter ||
                                  HardwareKeyboard.instance.isShiftPressed ||
                                  !_commandFocusNode.hasFocus ||
                                  !_isConnected) {
                                return;
                              }
                              final now = DateTime.now();
                              if (_lastPromptSubmitTime != null &&
                                  now
                                          .difference(_lastPromptSubmitTime!)
                                          .inMilliseconds <
                                      400) {
                                return;
                              }
                              final text = _commandController.text.trim();
                              if (text.isEmpty) return;
                              _lastPromptSubmitTime = now;
                              _submitPromptToAgent(text);
                              _clearCommandInput();
                            },
                            // ValueListenableBuilder around the input avoids rebuilding the whole UI
                            child: ValueListenableBuilder<TextEditingValue>(
                              valueListenable: _commandController,
                              builder: (context, textValue, child) {
                                final hasText =
                                    textValue.text.trim().isNotEmpty;
                                return TextField(
                                  key: ValueKey(_textFieldKey),
                                  controller: _commandController,
                                  focusNode: _commandFocusNode,
                                  decoration: InputDecoration(
                                    labelText: 'Enter prompt',
                                    hintText: 'Type your request to Cursor…',
                                    prefixIcon: const Icon(Icons.edit_note),
                                    suffixIcon: hasText
                                        ? IconButton(
                                            icon: Icon(
                                              Icons.clear,
                                              size: 20,
                                              color: Theme.of(context)
                                                  .colorScheme
                                                  .onSurfaceVariant,
                                            ),
                                            onPressed: _clearCommandInput,
                                          )
                                        : null,
                                  ),
                                  textInputAction: TextInputAction.newline,
                                  keyboardType: TextInputType.multiline,
                                  maxLines: 3,
                                  minLines: 2,
                                  enableSuggestions: true,
                                  autocorrect: true,
                                  textCapitalization: TextCapitalization.none,
                                );
                              },
                            ),
                          ),
                          const SizedBox(height: 12),
                          // Same for the button area
                          ValueListenableBuilder<TextEditingValue>(
                            valueListenable: _commandController,
                            builder: (context, textValue, child) {
                              final hasText = textValue.text.trim().isNotEmpty;
                              return Row(
                                children: [
                                  Expanded(
                                    child: FilledButton.icon(
                                      onPressed: _isConnected &&
                                              hasText &&
                                              !_isWaitingForResponse
                                          ? () {
                                              if (!mounted) return;
                                              final text = _commandController
                                                  .text
                                                  .trim();
                                              if (text.isNotEmpty) {
                                                _submitPromptToAgent(text);
                                                _clearCommandInput();
                                              }
                                            }
                                          : null,
                                      icon: _isWaitingForResponse
                                          ? SizedBox(
                                              width: 16,
                                              height: 16,
                                              child: CircularProgressIndicator(
                                                strokeWidth: 2,
                                                valueColor:
                                                    AlwaysStoppedAnimation<
                                                        Color>(
                                                  Theme.of(context)
                                                      .colorScheme
                                                      .onPrimary,
                                                ),
                                              ),
                                            )
                                          : const Icon(Icons.send, size: 18),
                                      label: Text(_isWaitingForResponse
                                          ? 'Sending…'
                                          : 'Send'),
                                      style: FilledButton.styleFrom(
                                        padding: const EdgeInsets.symmetric(
                                            vertical: 14),
                                      ),
                                    ),
                                  ),
                                  const SizedBox(width: 8),
                                  if (_isWaitingForResponse) ...[
                                    OutlinedButton.icon(
                                      onPressed: _isConnected
                                          ? () {
                                              if (!mounted) return;
                                              setState(() {
                                                _isWaitingForResponse = false;
                                              });
                                              _sendCommand('stop_prompt');
                                            }
                                          : null,
                                      icon: const Icon(Icons.stop, size: 18),
                                      label: const Text('Stop'),
                                      style: OutlinedButton.styleFrom(
                                        padding: const EdgeInsets.symmetric(
                                            vertical: 14, horizontal: 16),
                                      ),
                                    ),
                                  ] else if (_selectedAgentBackend ==
                                      'cli') ...[
                                    OutlinedButton.icon(
                                      onPressed: _isConnected && hasText
                                          ? () {
                                              if (!mounted) return;
                                              final text = _commandController
                                                  .text
                                                  .trim();
                                              if (text.isNotEmpty) {
                                                _submitPromptToAgent(text,
                                                    newSession: true);
                                                _clearCommandInput();
                                              }
                                            }
                                          : null,
                                      icon: const Icon(Icons.refresh, size: 18),
                                      label: const Text('New Chat'),
                                      style: OutlinedButton.styleFrom(
                                        padding: const EdgeInsets.symmetric(
                                            vertical: 14, horizontal: 16),
                                      ),
                                    ),
                                  ],
                                ],
                              );
                            },
                          ),
                          const SizedBox(height: 8),
                          // Session info and chat history (only when enabled in settings)
                          if (_isConnected && AppSettings().showHistory) ...[
                            // Current session info
                            if (_currentCursorSessionId != null)
                              Container(
                                padding: const EdgeInsets.all(12.0),
                                margin: const EdgeInsets.only(bottom: 8.0),
                                decoration: BoxDecoration(
                                  color: Theme.of(context)
                                      .colorScheme
                                      .primaryContainer
                                      .withValues(alpha: 0.3),
                                  borderRadius: BorderRadius.circular(12),
                                  border: Border.all(
                                    color: Theme.of(context)
                                        .colorScheme
                                        .primary
                                        .withValues(alpha: 0.2),
                                    width: 1,
                                  ),
                                ),
                                child: Row(
                                  children: [
                                    Icon(
                                      Icons.chat_bubble_outline,
                                      size: 18,
                                      color:
                                          Theme.of(context).colorScheme.primary,
                                    ),
                                    const SizedBox(width: 12),
                                    Expanded(
                                      child: Text(
                                        'Current session: ${_currentCursorSessionId!.substring(0, 8)}...',
                                        style: TextStyle(
                                          fontSize: 13,
                                          fontWeight: FontWeight.w500,
                                          color: Theme.of(context)
                                              .colorScheme
                                              .onSurface,
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                              ),

                            // Session list and chat history
                            Container(
                              margin: const EdgeInsets.only(top: 8.0),
                              child: Card(
                                child: ExpansionTile(
                                  title: Text(
                                    'Sessions & Chat History',
                                    style: TextStyle(
                                      fontSize: 15,
                                      fontWeight: FontWeight.w600,
                                      color: Theme.of(context)
                                          .colorScheme
                                          .onSurface,
                                    ),
                                  ),
                                  leading: Container(
                                    padding: const EdgeInsets.all(6),
                                    decoration: BoxDecoration(
                                      color: Theme.of(context)
                                          .colorScheme
                                          .secondaryContainer,
                                      borderRadius: BorderRadius.circular(8),
                                    ),
                                    child: Icon(
                                      Icons.history,
                                      size: 18,
                                      color: Theme.of(context)
                                          .colorScheme
                                          .onSecondaryContainer,
                                    ),
                                  ),
                                  children: [
                                    // Session list
                                    if (_availableSessions.isNotEmpty) ...[
                                      Padding(
                                        padding: const EdgeInsets.all(12.0),
                                        child: Text(
                                          'Available Sessions',
                                          style: TextStyle(
                                            fontWeight: FontWeight.w600,
                                            fontSize: 13,
                                            color: Theme.of(context)
                                                .colorScheme
                                                .onSurface,
                                          ),
                                        ),
                                      ),
                                      ..._availableSessions.map((sessionId) =>
                                          ListTile(
                                            dense: true,
                                            leading: const Icon(Icons.chat,
                                                size: 16),
                                            title: Text(
                                              sessionId.length > 20
                                                  ? '${sessionId.substring(0, 20)}...'
                                                  : sessionId,
                                              style:
                                                  const TextStyle(fontSize: 12),
                                            ),
                                            trailing: IconButton(
                                              icon: const Icon(Icons.refresh,
                                                  size: 16),
                                              onPressed: () => _loadChatHistory(
                                                  sessionId: sessionId),
                                              tooltip: 'Load chat history for this session',
                                            ),
                                          )),
                                      const Divider(),
                                    ],

                                    // Chat history
                                    if (_chatHistory.isNotEmpty) ...[
                                      Padding(
                                        padding: const EdgeInsets.all(12.0),
                                        child: Text(
                                          'Chat History',
                                          style: TextStyle(
                                            fontWeight: FontWeight.w600,
                                            fontSize: 13,
                                            color: Theme.of(context)
                                                .colorScheme
                                                .onSurface,
                                          ),
                                        ),
                                      ),
                                      SizedBox(
                                        height: 200,
                                        child: ListView.builder(
                                          shrinkWrap: true,
                                          itemCount: _chatHistory.length,
                                          itemBuilder: (context, index) {
                                            final entry = _chatHistory[index];
                                            final userMsg = entry['userMessage']
                                                    as String? ??
                                                '';
                                            final assistantMsg =
                                                entry['assistantResponse']
                                                        as String? ??
                                                    '';
                                            final timestamp =
                                                entry['timestamp'] as String? ??
                                                    '';
                                            final agentMode =
                                                entry['agentMode'] as String?;

                                            // Debug: log every entry

                                            return Card(
                                              margin:
                                                  const EdgeInsets.symmetric(
                                                      horizontal: 8.0,
                                                      vertical: 4.0),
                                              elevation: 0,
                                              shape: RoundedRectangleBorder(
                                                borderRadius:
                                                    BorderRadius.circular(12),
                                                side: BorderSide(
                                                  color: Theme.of(context)
                                                      .colorScheme
                                                      .outline
                                                      .withValues(alpha: 0.1),
                                                  width: 1,
                                                ),
                                              ),
                                              child: Padding(
                                                padding:
                                                    const EdgeInsets.all(12.0),
                                                child: Column(
                                                  crossAxisAlignment:
                                                      CrossAxisAlignment.start,
                                                  children: [
                                                    if (userMsg.isNotEmpty)
                                                      Padding(
                                                        padding:
                                                            const EdgeInsets
                                                                .only(
                                                                bottom: 4.0),
                                                        child: Row(
                                                          crossAxisAlignment:
                                                              CrossAxisAlignment
                                                                  .start,
                                                          children: [
                                                            Expanded(
                                                              child: Text(
                                                                '👤 $userMsg',
                                                                style: const TextStyle(
                                                                    fontSize:
                                                                        11,
                                                                    fontWeight:
                                                                        FontWeight
                                                                            .bold),
                                                              ),
                                                            ),
                                                            // Agent mode badge (when non-null and non-empty, including auto)
                                                            if (agentMode !=
                                                                    null &&
                                                                agentMode
                                                                    .isNotEmpty) ...[
                                                              const SizedBox(
                                                                  width: 4),
                                                              Container(
                                                                padding: const EdgeInsets
                                                                    .symmetric(
                                                                    horizontal:
                                                                        6,
                                                                    vertical:
                                                                        3),
                                                                decoration:
                                                                    BoxDecoration(
                                                                  color: Theme.of(
                                                                          context)
                                                                      .colorScheme
                                                                      .primaryContainer,
                                                                  borderRadius:
                                                                      BorderRadius
                                                                          .circular(
                                                                              8),
                                                                  border: Border
                                                                      .all(
                                                                    color: Theme.of(
                                                                            context)
                                                                        .colorScheme
                                                                        .primary
                                                                        .withValues(alpha: 
                                                                            0.3),
                                                                    width: 1,
                                                                  ),
                                                                ),
                                                                child: Row(
                                                                  mainAxisSize:
                                                                      MainAxisSize
                                                                          .min,
                                                                  children: [
                                                                    Icon(
                                                                      _getModeIcon(
                                                                          agentMode),
                                                                      size: 12,
                                                                      color: Theme.of(
                                                                              context)
                                                                          .colorScheme
                                                                          .onPrimaryContainer,
                                                                    ),
                                                                    const SizedBox(
                                                                        width:
                                                                            4),
                                                                    Text(
                                                                      _getModeDisplayName(
                                                                          agentMode),
                                                                      style:
                                                                          TextStyle(
                                                                        fontSize:
                                                                            10,
                                                                        fontWeight:
                                                                            FontWeight.w600,
                                                                        color: Theme.of(context)
                                                                            .colorScheme
                                                                            .onPrimaryContainer,
                                                                      ),
                                                                    ),
                                                                  ],
                                                                ),
                                                              ),
                                                            ],
                                                          ],
                                                        ),
                                                      ),
                                                    if (assistantMsg.isNotEmpty)
                                                      Padding(
                                                        padding:
                                                            const EdgeInsets
                                                                .only(
                                                                bottom: 4.0),
                                                        child: Text(
                                                          '🤖 ${assistantMsg.length > 50 ? "${assistantMsg.substring(0, 50)}..." : assistantMsg}',
                                                          style:
                                                              const TextStyle(
                                                                  fontSize: 11),
                                                        ),
                                                      ),
                                                    if (timestamp.isNotEmpty)
                                                      Text(
                                                        _formatTime(
                                                            DateTime.parse(
                                                                timestamp)),
                                                        style: TextStyle(
                                                          fontSize: 9,
                                                          color: Theme.of(
                                                                  context)
                                                              .colorScheme
                                                              .onSurfaceVariant,
                                                        ),
                                                      ),
                                                  ],
                                                ),
                                              ),
                                            );
                                          },
                                        ),
                                      ),
                                    ] else ...[
                                      Padding(
                                        padding: const EdgeInsets.all(24.0),
                                        child: Column(
                                          children: [
                                            Icon(
                                              Icons.history,
                                              size: 48,
                                              color: Theme.of(context)
                                                  .colorScheme
                                                  .onSurfaceVariant
                                                  .withValues(alpha: 0.4),
                                            ),
                                            const SizedBox(height: 12),
                                            Text(
                                              'No chat history',
                                              style: TextStyle(
                                                fontSize: 14,
                                                fontWeight: FontWeight.w500,
                                                color: Theme.of(context)
                                                    .colorScheme
                                                    .onSurfaceVariant,
                                              ),
                                            ),
                                          ],
                                        ),
                                      ),
                                    ],

                                    // Refresh button
                                    Padding(
                                      padding: const EdgeInsets.all(12.0),
                                      child: OutlinedButton.icon(
                                        onPressed: () {
                                          _loadSessionInfo();
                                          _loadChatHistory();
                                        },
                                        icon:
                                            const Icon(Icons.refresh, size: 18),
                                        label: const Text('Refresh'),
                                        style: OutlinedButton.styleFrom(
                                          padding: const EdgeInsets.symmetric(
                                              horizontal: 20, vertical: 12),
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ],
                          ], // end if (_selectedAgentBackend == 'cli')
                        ],
                      ),
                    ),
                  ),
                ],
              ],
            );
              },
            ),
      ),
    );
  }
}

// ============================================================
// Settings Page
// ============================================================
class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key, this.relaySession, this.onLogOut});

  final String? relaySession;
  /// Asks, then logs out of [relaySession]; true if it did. Null when not on the relay.
  final Future<bool> Function()? onLogOut;

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  final AppSettings _settings = AppSettings();

  @override
  void initState() {
    super.initState();
    _settings.addListener(_onSettingsChanged);
  }

  @override
  void dispose() {
    _settings.removeListener(_onSettingsChanged);
    super.dispose();
  }

  void _onSettingsChanged() {
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Cr.bg,
      appBar: AppBar(
        title: const Text(
          'Settings',
          style: TextStyle(fontWeight: FontWeight.w600),
        ),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_rounded),
          onPressed: () => Navigator.of(context).pop(),
        ),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(height: 1, color: Cr.borderSubtle),
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.symmetric(vertical: 8),
        children: [
          CrPanel(
            margin: const EdgeInsets.fromLTRB(12, 8, 12, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Padding(
                  padding: EdgeInsets.fromLTRB(16, 14, 16, 4),
                  child: CrSectionLabel('Features'),
                ),
                _buildShowHistoryTile(),
              ],
            ),
          ),
          if (widget.onLogOut != null)
            CrPanel(
              margin: const EdgeInsets.fromLTRB(12, 0, 12, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Padding(
                    padding: EdgeInsets.fromLTRB(16, 14, 16, 4),
                    child: CrSectionLabel('Relay'),
                  ),
                  ListTile(
                    leading: const Icon(Icons.logout_rounded, color: Cr.danger),
                    title: const Text('Log out', style: TextStyle(color: Cr.danger)),
                    subtitle: Text('Session ${widget.relaySession ?? ''}'),
                    onTap: () async {
                      final navigator = Navigator.of(context);
                      if (await widget.onLogOut!() && mounted) navigator.pop();
                    },
                  ),
                ],
              ),
            ),
          CrPanel(
            margin: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Padding(
                  padding: EdgeInsets.fromLTRB(16, 14, 16, 4),
                  child: CrSectionLabel('About'),
                ),
                _buildAboutTile(),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildShowHistoryTile() {
    return SwitchListTile(
      secondary: Container(
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.secondaryContainer,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Icon(
          Icons.history,
          color: Theme.of(context).colorScheme.onSecondaryContainer,
          size: 20,
        ),
      ),
      title: const Text('Sessions & Chat History'),
      subtitle: const Text('Show history section on main screen'),
      value: _settings.showHistory,
      onChanged: (value) => _settings.setShowHistory(value),
    );
  }

  Widget _buildAboutTile() {
    return ListTile(
      leading: Container(
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Icon(
          Icons.info_outline,
          color: Theme.of(context).colorScheme.onSurfaceVariant,
          size: 20,
        ),
      ),
      title: const Text('Cursor Remote'),
      subtitle: const Text('v0.1.0'),
      onTap: () => _showAboutDialog(),
    );
  }

  void _showAboutDialog() {
    showAboutDialog(
      context: context,
      applicationName: 'Cursor Remote',
      applicationVersion: '0.1.0',
      applicationIcon: Container(
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.primaryContainer,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Icon(
          Icons.code,
          size: 32,
          color: Theme.of(context).colorScheme.onPrimaryContainer,
        ),
      ),
      children: [
        const SizedBox(height: 16),
        const Text(
          'Control Cursor AI remotely from your mobile device.',
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 8),
        Text(
          '© 2026 Krishna Gupta',
          style: TextStyle(
            fontSize: 12,
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
          textAlign: TextAlign.center,
        ),
      ],
    );
  }
}
