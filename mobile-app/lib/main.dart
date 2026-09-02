import 'dart:convert';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'models/connection_models.dart';
import 'services/app_settings.dart';
import 'services/cdp_session_store.dart';
import 'screens/agent_control_center.dart';
import 'theme/app_theme.dart';
import 'widgets/cr_ui.dart';

// Relay server URL (public default; override requires rebuild)
const String kRelayServerUrl = 'https://relay.jaloveeye.com';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await AppSettings().load();
  runApp(const MyApp());
}

final ThemeData lightTheme = buildCrLightTheme();
final ThemeData darkTheme = buildCrDarkTheme();

// ============================================================
// App Root
// ============================================================
class MyApp extends StatefulWidget {
  const MyApp({super.key});

  @override
  State<MyApp> createState() => _MyAppState();
}

class _MyAppState extends State<MyApp> {
  @override
  void initState() {
    super.initState();
    AppSettings().addListener(_onSettingsChanged);
  }

  @override
  void dispose() {
    AppSettings().removeListener(_onSettingsChanged);
    super.dispose();
  }

  void _onSettingsChanged() {
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Cursor Remote',
      theme: lightTheme,
      darkTheme: darkTheme,
      themeMode: AppSettings().themeModeValue,
      home: const HomePage(),
    );
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

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
  final String type; // MessageType 상수 사용
  final DateTime timestamp;
  String? agentMode; // 에이전트 모드 (userPrompt 타입일 때만 사용)
  LogLevel? logLevel; // 로그 레벨 (log 타입일 때만 사용)

  MessageItem(this.text,
      {this.type = MessageType.normal, this.agentMode, this.logLevel})
      : timestamp = DateTime.now();

  // 필터 카테고리 결정
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
  // 연결 타입
  ConnectionType _connectionType = ConnectionType.relay;

  // Relay 서버 관련
  String? _sessionId;
  String _deviceId = '';
  bool _isConnected = false;
  bool _isConnecting = false;
  bool _isWaitingForResponse = false; // waiting for AI response

  // Cursor CLI 세션 관련
  String? _currentCursorSessionId; // 현재 Cursor CLI 세션 ID
  String? _currentClientId; // 현재 클라이언트 ID
  Timer? _pollTimer;

  // 스트리밍 관련
  int? _streamingMessageIndex; // 현재 스트리밍 중인 메시지의 인덱스
  String _streamingText = ''; // 스트리밍 중인 텍스트

  // 세션 및 대화 히스토리
  Map<String, dynamic>? _sessionInfo; // 현재 세션 정보
  List<Map<String, dynamic>> _chatHistory = []; // 대화 히스토리 목록
  List<String> _availableSessions = []; // 사용 가능한 세션 목록
  List<Map<String, dynamic>> _pendingCommandApprovals = [];
  List<Map<String, dynamic>> _recentCommandEvents = [];
  bool _loadingCommandApprovals = false;
  bool _loadingCommandEvents = false;
  DateTime? _lastCommandMetaRefreshAt;
  /// 같은 세션 재연결 시 메인 목록에 히스토리 반영용 (get_chat_history 응답 시 사용)
  bool _loadingSessionHistoryForDisplay = false;

  /// 과거 메시지 불러오기 버튼으로 요청한 로드 (응답 시 _messages에 반영)
  bool _loadingPastMessages = false;

  // 로컬 서버 관련
  WebSocketChannel? _localWebSocket;
  final TextEditingController _localIpController = TextEditingController();
  final TextEditingController _localPortController =
      TextEditingController(text: '8766');

  // 재연결 관련
  Timer? _reconnectTimer;
  int _reconnectAttempts = 0;
  bool _isReconnecting = false;
  String? _lastConnectionError;

  // 에이전트 모드 관련
  String _selectedAgentMode = 'auto'; // auto, agent, ask, plan, debug
  String? _actualSelectedMode; // 자동 모드로 선택된 경우 실제 선택된 모드 (null이면 사용자가 직접 선택)
  MessageItem? _lastUserPrompt; // 마지막 User Prompt 메시지 (모드 업데이트용)

  // Agent backend: CLI (new agent) vs CDP (existing Cursor IDE session)
  String _selectedAgentBackend = 'cli'; // cli | cdp
  final CdpSessionStore _cdpStore = CdpSessionStore();
  String? get _selectedCdpSessionId =>
      _cdpStore.sessions.keys.isEmpty ? null : _cdpStore.sessions.keys.first;

  final List<MessageItem> _messages = [];
  final TextEditingController _commandController = TextEditingController();
  final TextEditingController _sessionIdController = TextEditingController();

  // 입력창 상태 관리
  int _textFieldKey = 0; // TextField 재생성용 Key
  DateTime? _lastPromptSubmitTime; // Enter 중복 전송 방지용 debounce
  final FocusNode _sessionIdFocusNode = FocusNode();
  final FocusNode _localIpFocusNode = FocusNode();
  final FocusNode _commandFocusNode = FocusNode();
  final ScrollController _scrollController = ScrollController();
  // ignore: deprecated_member_use
  final ExpansionTileController _expansionTileController =
      // ignore: deprecated_member_use
      ExpansionTileController();

  /// 스크롤 버튼 표시: 위로/아래로 스크롤 가능할 때만
  bool _canScrollUp = false;
  bool _canScrollDown = false;

  /// 연결 후 컴팩트 뷰 (메시지 크게 + 한줄 프롬프트만)
  bool _isCompactView = false;

  // 필터 상태 (기본값: AI 응답 + 사용자 프롬프트만 활성화)
  final Map<MessageFilter, bool> _activeFilters = {
    MessageFilter.aiResponse: true,
    MessageFilter.userPrompt: true,
    MessageFilter.system: false,
    MessageFilter.log: false,
  };

  // 로그 레벨별 필터 상태 (기본값: 모두 활성화)
  final Map<LogLevel, bool> _logLevelFilters = {
    LogLevel.error: true,
    LogLevel.warning: true,
    LogLevel.info: true,
  };

  // 필터링된 메시지 목록 (카테고리 필터만)
  List<MessageItem> get _filteredMessages {
    return _messages.where((msg) {
      final category = msg.filterCategory;
      if (category == null) return true;

      // 로그 메시지인 경우 레벨별 필터도 적용
      if (category == MessageFilter.log &&
          (_activeFilters[MessageFilter.log] ?? false)) {
        final level = msg.logLevel ?? LogLevel.info;
        if (!(_logLevelFilters[level] ?? true)) return false;
      }

      return _activeFilters[category] ?? true;
    }).toList();
  }

  // 검색: 전체(프롬프트+답변) 또는 답변만
  static const String _searchScopeAll = 'all';
  static const String _searchScopeAnswerOnly = 'answer_only';
  String _searchQuery = '';
  String _searchScope = _searchScopeAll;

  // 검색 적용된 표시용 메시지 목록
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
    if (_isConnecting) return;
    setState(() {
      _isConnecting = true;
      _lastConnectionError = null;
      _messages.add(
          MessageItem('Creating new session…', type: MessageType.system));
    });

    try {
      final response = await http
          .post(
            Uri.parse('$kRelayServerUrl/api/session'),
            headers: {'Content-Type': 'application/json'},
          )
          .timeout(const Duration(seconds: 15));

      if (response.statusCode == 201) {
        final data = jsonDecode(response.body);
        if (data['success'] == true) {
          final sessionId = data['data']['sessionId'] as String;
          setState(() {
            _sessionIdController.text = sessionId;
            _messages.add(MessageItem('✅ Session created: $sessionId',
                type: MessageType.system));
            _messages.add(MessageItem(
                '💡 The Cursor Remote extension will automatically detect this session (may take up to 10 seconds)',
                type: MessageType.system));
            _messages.add(
                MessageItem('📋 Session ID: $sessionId', type: MessageType.system));
          });

          await _connectToSession(sessionId);
          return;
        }
      }
      setState(() {
        _isConnecting = false;
        _lastConnectionError =
            'Failed to create session (HTTP ${response.statusCode})';
        _messages.add(MessageItem(
            '❌ Failed to create session. Check your internet connection and try again.',
            type: MessageType.system));
      });
    } catch (e) {
      setState(() {
        _isConnecting = false;
        _lastConnectionError = e.toString();
        _messages.add(MessageItem(
            '❌ Unable to create a relay session. Check your internet connection and try again.',
            type: MessageType.system));
      });
    }
  }

  // Connect to local server (direct WebSocket)
  Future<void> _connectToLocal() async {
    if (_isConnecting) return;

    var host = _localIpController.text.trim();
    if (host.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please enter the PC hostname or IP address')),
      );
      return;
    }

    // Allow full ws:// or wss:// URLs in the host field
    String scheme = 'ws';
    int? portFromUrl;
    if (host.startsWith('ws://') || host.startsWith('wss://')) {
      try {
        final uri = Uri.parse(host);
        scheme = uri.scheme;
        host = uri.host;
        if (uri.hasPort) portFromUrl = uri.port;
      } catch (_) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Invalid WebSocket URL. Example: ws://192.168.1.10:8766')),
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
    final port = portFromUrl ?? int.tryParse(portText);
    if (port == null || port < 1 || port > 65535) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Port must be a number between 1 and 65535')),
      );
      return;
    }

    // Reflect parsed values back into the form
    _localIpController.text = host;
    _localPortController.text = port.toString();

    final wsUrl = '$scheme://$host:$port';

    // Close any prior socket before opening a new one
    try {
      await _localWebSocket?.sink.close();
    } catch (_) {}
    _localWebSocket = null;
    _stopReconnect();

    setState(() {
      _isConnecting = true;
      _isConnected = false;
      _lastConnectionError = null;
      _messages.add(MessageItem(
          'Connecting to Cursor Remote server at $host:$port…',
          type: MessageType.system));
    });

    var handshakeComplete = false;
    Timer? connectionTimeout;

    void failConnection(String userMessage, {String? technical, bool scheduleRetry = true}) {
      if (!mounted || handshakeComplete) return;
      handshakeComplete = true;
      connectionTimeout?.cancel();
      try {
        _localWebSocket?.sink.close();
      } catch (_) {}
      _localWebSocket = null;
      setState(() {
        _isConnecting = false;
        _isConnected = false;
        _lastConnectionError = technical ?? userMessage;
        _messages.add(MessageItem('❌ $userMessage', type: MessageType.system));
      });
      if (scheduleRetry) _scheduleReconnect();
    }

    void succeedConnection() {
      if (!mounted || handshakeComplete) return;
      handshakeComplete = true;
      connectionTimeout?.cancel();
      setState(() {
        _isConnecting = false;
        _isConnected = true;
        _isReconnecting = false;
        _reconnectAttempts = 0;
        _lastConnectionError = null;
        _stopReconnect();
        _messages.add(MessageItem(
            '✅ Connected to Cursor Remote server at $host:$port',
            type: MessageType.system));
      });

      _saveConnectionSettings();
      AppSettings().addConnectionHistory(ConnectionHistoryItem(
        type: ConnectionType.local,
        ip: host,
        port: port,
        timestamp: DateTime.now(),
      ));

      try {
        _expansionTileController.collapse();
      } catch (_) {}

      Future.delayed(const Duration(milliseconds: 300), () {
        if (mounted) _loadChatHistory();
      });
      Future.delayed(const Duration(milliseconds: 500), () {
        if (mounted && _selectedAgentBackend == 'cdp') {
          _refreshCdpSessions();
        }
      });
    }

    try {
      _localWebSocket = WebSocketChannel.connect(Uri.parse(wsUrl));

      connectionTimeout = Timer(const Duration(seconds: 10), () {
        failConnection(
          'Unable to connect to the Cursor Remote server. '
          'Check that Cursor is open with the extension running, '
          'and that your phone and Mac are on the same Wi-Fi network.',
          technical:
              'Connection timed out after 10s ($wsUrl). Extension may not be listening on port $port.',
        );
      });

      _localWebSocket!.stream.listen(
        (message) {
          final raw = message.toString();
          // First message (typically type: connected) confirms the handshake
          if (!handshakeComplete) {
            succeedConnection();
          }
          _handleLocalMessage(raw);
        },
        onError: (error) {
          final friendly =
              'Unable to connect to the local Cursor Remote server. '
              'Make sure the Cursor extension is running and the server is listening on port $port.';
          failConnection(friendly, technical: error.toString());
        },
        onDone: () {
          if (!handshakeComplete) {
            failConnection(
              'Unable to connect to the local Cursor Remote server. '
              'The connection closed before the handshake completed.',
              technical: 'WebSocket closed before handshake ($wsUrl)',
            );
            return;
          }
          if (mounted) {
            setState(() {
              _messages.add(MessageItem(
                  'Connection closed.',
                  type: MessageType.system));
              _isConnected = false;
              _isConnecting = false;
            });
            _scheduleReconnect();
          }
        },
        cancelOnError: true,
      );
    } catch (e) {
      failConnection(
        'Unable to connect to the local Cursor Remote server. '
        'Check the address and that the extension is running.',
        technical: e.toString(),
        scheduleRetry: false,
      );
    }
  }

  // Handle messages from local WebSocket server
  void _handleLocalMessage(String message) {
    if (!mounted) return;

    try {
      final data = jsonDecode(message);
      final type = data['type'] ?? 'unknown';

      setState(() {
        if (type == 'chat_response') {
          // 세션 ID 추출 및 저장
          if (data['sessionId'] != null) {
            setState(() {
              _currentCursorSessionId = data['sessionId'] as String;
            });
          }
          if (data['clientId'] != null) {
            final newClientId = data['clientId'] as String;
            setState(() {
              // clientId가 처음 설정되면 세션 정보 및 히스토리 조회
              if (_currentClientId == null) {
                _currentClientId = newClientId;
                _loadSessionInfo();
                _loadChatHistory();
              } else if (_currentClientId != newClientId) {
                // clientId가 변경된 경우
                _currentClientId = newClientId;
                _loadSessionInfo();
                _loadChatHistory();
              } else {
                // 같은 clientId면 히스토리만 새로고침
                Future.delayed(const Duration(milliseconds: 500), () {
                  _loadChatHistory();
                });
              }
            });
          } else if (_currentClientId != null) {
            // clientId가 이미 있으면 응답 수신 후 히스토리만 새로고침
            Future.delayed(const Duration(milliseconds: 500), () {
              _loadChatHistory();
            });
          }
          final text = data['text'] ?? '';
          _messages.add(MessageItem('', type: MessageType.chatResponseDivider));
          _messages.add(MessageItem('🤖 Cursor AI Response',
              type: MessageType.chatResponseHeader));
          _messages.add(MessageItem(text, type: MessageType.chatResponse));
          _messages.add(MessageItem('', type: MessageType.chatResponseDivider));
          _isWaitingForResponse = false;
        } else if (type == 'command_result') {
          if (data['success'] == true) {
            final commandType = data['command_type'] as String? ?? '';

            // 세션 정보 조회 결과 처리
            if (commandType == 'get_session_info' && data['data'] != null) {
              setState(() {
                _sessionInfo = data['data'] as Map<String, dynamic>;
                if (_sessionInfo!['currentSessionId'] != null) {
                  _currentCursorSessionId =
                      _sessionInfo!['currentSessionId'] as String;
                }
                if (_sessionInfo!['clientId'] != null) {
                  _currentClientId = _sessionInfo!['clientId'] as String;
                }
              });
            }
            // 대화 히스토리 조회 결과 처리 (Extension은 data에 배열 직접 반환 또는 { entries: [] } 반환)
            else if (commandType == 'get_chat_history' &&
                data['data'] != null) {
              final raw = data['data'];
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
                setState(() {
                  _chatHistory = entries;
                  _availableSessions = _chatHistory
                      .map((entry) => entry['sessionId'] as String? ?? '')
                      .where((id) => id.isNotEmpty)
                      .toSet()
                      .toList();
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
                });
              } else {
                if (_loadingSessionHistoryForDisplay) {
                  _loadingSessionHistoryForDisplay = false;
                }
                if (_loadingPastMessages) _loadingPastMessages = false;
              }
            }

            // 일반 명령 성공 메시지는 세션/히스토리 조회 시에는 표시하지 않음
            if (commandType != 'get_session_info' &&
                commandType != 'get_chat_history') {
              _messages.add(
                  MessageItem('✅ Command succeeded', type: MessageType.system));
            }
            if (commandType == 'stop_prompt') {
              _isWaitingForResponse = false;
            }
          } else {
            _messages.add(MessageItem('❌ Command failed: ${data['error']}',
                type: MessageType.system));
            _isWaitingForResponse = false;
          }
        } else if (type == 'log') {
          // 실시간 로그 메시지 처리
          final logLevelStr = data['level'] ?? 'info';
          final logMessage = data['message'] ?? '';
          final logSource = data['source'] ?? 'unknown';
          final logError = data['error'];

          // 로그 레벨 파싱
          LogLevel parsedLogLevel;
          switch (logLevelStr) {
            case 'error':
              parsedLogLevel = LogLevel.error;
              break;
            case 'warn':
            case 'warning':
              parsedLogLevel = LogLevel.warning;
              break;
            default:
              parsedLogLevel = LogLevel.info;
          }

          String logPrefix = '';
          switch (logSource) {
            case 'extension':
              logPrefix = '🔌 [Extension]';
              break;
            case 'pc-server':
              logPrefix = '🖥️ [PC Server]';
              break;
            default:
              logPrefix = '📝 [Log]';
          }

          String logText = '$logPrefix $logMessage';
          if (logError != null) {
            logText += ' - Error: $logError';
          }

          _messages.add(MessageItem(logText,
              type: MessageType.log, logLevel: parsedLogLevel));
        } else if (type == 'agent_mode_selected') {
          // 자동 모드로 선택된 실제 모드 정보
          final requestedMode = data['requestedMode'] ?? 'auto';
          final actualMode = data['actualMode'] ?? 'agent';
          final displayName = data['displayName'] ?? actualMode;


          if (mounted) {
            setState(() {
              // 자동 모드로 선택된 경우에만 표시
              if (requestedMode == 'auto' && _selectedAgentMode == 'auto') {
                _actualSelectedMode = actualMode;

                // 마지막 User Prompt의 모드 업데이트
                // 메시지 리스트에서 가장 최근 User Prompt 찾아서 업데이트
                bool found = false;
                for (int i = _messages.length - 1; i >= 0; i--) {
                  if (_messages[i].type == MessageType.userPrompt) {
                    // agentMode가 null인 경우 (자동 모드로 전송된 경우) 업데이트
                    if (_messages[i].agentMode == null) {
                      final updatedItem = MessageItem(
                        _messages[i].text,
                        type: _messages[i].type,
                        agentMode: actualMode,
                      );
                      _messages[i] = updatedItem;
                      // _lastUserPrompt도 업데이트
                      if (_lastUserPrompt != null &&
                          _lastUserPrompt!.text == _messages[i].text) {
                        _lastUserPrompt = updatedItem;
                      }
                      found = true;
                      break;
                    }
                  }
                }

                if (!found) {
                } else {
                  // UI 강제 업데이트를 위해 스크롤
                  Future.microtask(() {
                    if (mounted) {
                      _scrollToBottom();
                    }
                  });
                }
              }
            });

            // 사용자에게 알림 (SnackBar)
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                content: Text('🤖 Auto mode: $displayName'),
                duration: const Duration(seconds: 2),
                backgroundColor: Colors.blue.shade700,
              ),
            );
          }
        } else if (type == 'connection_status') {
          final status = data['status'] ?? 'unknown';
          final message = data['message'] ?? '';
          final errorCode = data['errorCode']?.toString();

          String statusText = '';
          switch (status) {
            case 'connected':
              statusText = '✅ $message';
              setState(() {
                _isReconnecting = false;
                _reconnectAttempts = 0;
                _stopReconnect();
              });
              break;
            case 'disconnected':
              statusText = '⚠️ $message';
              setState(() {
                _isConnected = false;
              });
              _scheduleReconnect();
              break;
            case 'error':
              final detail = (errorCode != null && errorCode.isNotEmpty)
                  ? '$message ($errorCode)'
                  : message;
              statusText = '❌ $detail';
              setState(() {
                _isConnected = false;
                _lastConnectionError = detail;
              });
              _scheduleReconnect();
              break;
          }

          if (statusText.isNotEmpty) {
            _messages.add(MessageItem(statusText, type: MessageType.system));
          }
        } else {
          _applyCdpInbound(data);
        }
      });
      _scrollToBottom();
    } catch (e) {
      // JSON 파싱 실패 시 원본 메시지 표시
      if (mounted) {
        setState(() {
          _messages
              .add(MessageItem('Received: $message', type: MessageType.system));
        });
      }
    }
  }

  /// Apply allowlisted CDP / Existing Agent WebSocket payloads.
  void _applyCdpInbound(Map<String, dynamic> data) {
    final type = data['type']?.toString() ?? '';
    final cdpTypes = {
      'cdp_status',
      'cdp_targets',
      'sessions',
      'agent_history',
      'agent_state',
      'agent_state_changed',
      'agent_message',
      'agent_message_delta',
      'permission_request',
      'permission_resolved',
      'agent_completed',
      'agent_plan',
      'agent_plan_changed',
      'file_changed',
      'activity_event',
      'agent_error',
    };
    if (!cdpTypes.contains(type)) return;
    _cdpStore.applyInbound(data);
    if (type == 'agent_completed' ||
        (type == 'agent_state' &&
            (data['state'] == 'COMPLETED' || data['state'] == 'IDLE'))) {
      _isWaitingForResponse = false;
    }
    if (type == 'agent_message') {
      final m = data['message'];
      if (m is Map && m['role'] == 'assistant') {
        _isWaitingForResponse = false;
      }
    }
  }

  void _refreshCdpSessions() {
    if (!_isConnected) return;
    _sendCommand('cdp_status');
    _sendCommand('get_sessions');
    _sendCommand('get_agent_history');
  }

  Future<void> _sendCdpControlCommand(String type,
      {String? sessionId, String? text, String? requestId, String? historyId}) {
    return _sendCommand(
      type,
      text: text,
      sessionId: sessionId,
      requestId: requestId,
      historyId: historyId,
      prompt: type == 'agent_prompt' ? true : null,
      execute: type == 'agent_prompt' ? true : null,
      agentBackend: type == 'agent_prompt' ? 'cdp' : null,
    );
  }

  Future<void> _submitPromptToAgent(String text, {bool newSession = false}) {
    if (_selectedAgentBackend == 'cdp') {
      return _sendCommand(
        'agent_prompt',
        text: text,
        prompt: true,
        execute: true,
        sessionId: _selectedCdpSessionId,
        agentMode: _selectedAgentMode,
        agentBackend: 'cdp',
      );
    }
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
        title: const Text('PIN Required'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'This session is PIN-protected.\nEnter the 4–6 digit PIN set on the PC (Cursor extension).',
                style: TextStyle(fontSize: 14),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: controller,
                keyboardType: TextInputType.text,
                obscureText: true,
                maxLength: 6,
                autofocus: true,
                textInputAction: TextInputAction.done,
                onSubmitted: (_) => navigator.pop(controller.text.trim()),
                inputFormatters: [
                  FilteringTextInputFormatter.digitsOnly,
                ],
                decoration: const InputDecoration(
                  labelText: 'PIN',
                  hintText: '4–6 digits',
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
  Future<void> _connectToSession(String sessionId, [String? pin]) async {
    if (sessionId.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please enter a Session ID')),
      );
      return;
    }

    // Create device ID if missing
    if (_deviceId.isEmpty) {
      _deviceId = 'mobile-${DateTime.now().millisecondsSinceEpoch}';
    }

    try {
      if (!_isConnecting) {
        setState(() {
          _isConnecting = true;
          _lastConnectionError = null;
        });
      }
      setState(() {
        _messages.add(MessageItem(
            pin != null
                ? 'Connecting to session $sessionId with PIN...'
                : 'Connecting to session $sessionId...',
            type: MessageType.system));
      });

      final body = <String, dynamic>{
        'sessionId': sessionId,
        'deviceId': _deviceId,
        'deviceType': 'mobile',
      };
      if (pin != null && pin.isNotEmpty) {
        body['pin'] = pin;
      }

      final response = await http
          .post(
            Uri.parse('$kRelayServerUrl/api/connect'),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode(body),
          )
          .timeout(const Duration(seconds: 15));

      final data = response.body.isNotEmpty
          ? jsonDecode(response.body) as Map<String, dynamic>?
          : <String, dynamic>{};
      final dataMap = data ?? {};
      final errorCode = dataMap['errorCode']?.toString();
      final errorMessage = dataMap['error']?.toString() ?? '';

      if (response.statusCode == 200 && dataMap['success'] == true) {
        setState(() {
          _sessionId = sessionId;
          _isConnected = true;
          _isConnecting = false;
          _isReconnecting = false;
          _reconnectAttempts = 0;
          _lastConnectionError = null;
          _lastCommandMetaRefreshAt = null;
          _stopReconnect();
          _messages.add(MessageItem('✅ Connected to session $sessionId',
              type: MessageType.system));
        });

        // Save connection settings
        _saveConnectionSettings();

        // Add to connection history
        AppSettings().addConnectionHistory(ConnectionHistoryItem(
          type: ConnectionType.relay,
          sessionId: sessionId,
          timestamp: DateTime.now(),
        ));

        // Auto-collapse connection panel on success
        try {
          _expansionTileController.collapse();
        } catch (e) {
          // Ignore if ExpansionTileController is not attached yet
        }

        // Start polling
        _startPolling();

        // 같은 세션이면 이전 프롬프트/답변을 메인 목록에 가져오기 위해 해당 세션 히스토리 조회
        _loadingSessionHistoryForDisplay = true;
        Future.delayed(const Duration(milliseconds: 300), () {
          _loadChatHistory(sessionId: _sessionId);
        });
        Future.delayed(const Duration(milliseconds: 300), () {
          _loadCommandApprovals(silent: true);
          _loadCommandEvents(silent: true);
        });
      } else if (response.statusCode == 403 &&
          (errorCode == 'PIN_REQUIRED' ||
              errorMessage.toLowerCase().contains('pin required') ||
              errorMessage.toLowerCase().contains('pin을 입력') ||
              errorMessage.toLowerCase().contains('enter a pin'))) {
        // PC has set a PIN — prompt user then retry
        if (!mounted) return;
        setState(() {
          _messages.add(MessageItem(
              'This session requires a PIN. Please enter the PIN set on the PC.',
              type: MessageType.system));
        });
        final enteredPin = await _showPinDialog();
        if (!mounted) return;
        if (enteredPin != null && enteredPin.isNotEmpty) {
          await _connectToSession(sessionId, enteredPin);
        } else {
          setState(() {
            _isConnecting = false;
            _messages.add(MessageItem('Connection cancelled — no PIN entered.',
                type: MessageType.system));
          });
        }
      } else if (response.statusCode == 403 &&
          (errorCode == 'INVALID_PIN' ||
              errorMessage.toLowerCase().contains('invalid pin'))) {
        setState(() {
          _isConnecting = false;
          _lastConnectionError = 'Authentication failed: incorrect PIN';
          _messages.add(MessageItem(
              '❌ Incorrect PIN. Please check the PIN set on the PC (Cursor extension).',
              type: MessageType.system));
        });
        if (mounted) {
          await showDialog<void>(
            context: context,
            builder: (ctx) => AlertDialog(
              title: const Text('Incorrect PIN'),
              content: const Text(
                'The PIN you entered is incorrect.\nCheck the 4–6 digit PIN configured in the Cursor Remote extension on your PC.',
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.of(ctx).pop(),
                  child: const Text('OK'),
                ),
              ],
            ),
          );
        }
      } else if (response.statusCode == 403 &&
          (errorCode == 'PC_MUST_CONNECT_FIRST' ||
              errorMessage.toLowerCase().contains('pc must connect first'))) {
        setState(() {
          _isConnecting = false;
          _lastConnectionError =
              'The Cursor extension must connect to the relay session first.';
          _messages.add(MessageItem(
              '❌ The Cursor extension must connect first. Click the status bar item in Cursor to generate and connect with a Session ID, then try again.',
              type: MessageType.system));
        });
      } else {
        final error = errorMessage.isNotEmpty
            ? errorMessage
            : 'Unable to connect to the relay server (HTTP ${response.statusCode}).';
        setState(() {
          _isConnecting = false;
          _lastConnectionError = error;
          _messages
              .add(MessageItem('❌ Connection failed: $error', type: MessageType.system));
        });
        // Do not auto-create a new session on "Session not found"
        final isSessionNotFound =
            error.toLowerCase().contains('session not found');
        if (!isSessionNotFound) {
          _scheduleReconnect();
        }
      }
    } catch (e) {
      final friendly = e is TimeoutException
          ? 'The relay server did not respond in time. Check your internet connection and try again.'
          : 'Unable to reach the relay server. Check your internet connection and try again.';
      setState(() {
        _isConnecting = false;
        _lastConnectionError = e.toString();
        _messages.add(MessageItem('❌ $friendly', type: MessageType.system));
      });
      _scheduleReconnect();
    }
  }

  void _connect() {
    if (_isConnecting || _isConnected) return;
    if (_connectionType == ConnectionType.local) {
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

  // 히스토리에서 연결
  void _connectFromHistory(ConnectionHistoryItem item) {
    setState(() {
      _connectionType = item.type;
      if (item.type == ConnectionType.local) {
        _localIpController.text = item.ip ?? '';
        if (item.port != null) {
          _localPortController.text = item.port!.toString();
        }
      } else {
        _sessionIdController.text = item.sessionId ?? '';
      }
    });

    // 연결 시도
    _connect();
  }

  // 메시지 폴링 시작
  void _startPolling() {
    _stopPolling(); // 기존 타이머 정지

    _pollTimer = Timer.periodic(const Duration(seconds: 2), (_) async {
      if (!_isConnected || _sessionId == null) return;

      try {
        final response = await http.get(
          Uri.parse(
              '$kRelayServerUrl/api/poll?sessionId=$_sessionId&deviceType=mobile&deviceId=$_deviceId'),
        );

        if (response.statusCode == 200) {
          final data = jsonDecode(response.body);
          if (data['success'] == true && data['data']['messages'] != null) {
            final messages = data['data']['messages'] as List;
            for (final msg in messages) {
              _handleRelayMessage(msg);
            }
          }
          unawaited(_refreshCommandMetaIfStale());
        }
      } catch (e) {
        // 폴링 에러는 조용히 무시 (일시적인 네트워크 문제일 수 있음)
      }
    });
  }

  void _stopPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  // relay 서버에서 받은 메시지 처리
  void _handleRelayMessage(Map<String, dynamic> msg) {
    if (!mounted) return;

    final type = msg['type'] ?? msg['data']?['type'];
    final messageData = msg['data'] ?? msg;

    setState(() {
      _messages.add(MessageItem('Received: ${jsonEncode(msg)}',
          type: MessageType.system));

      if (type == 'command_result') {
        if (messageData['success'] == true) {
          final commandType = messageData['command_type'] as String? ?? '';

          // 세션 정보 조회 결과 처리
          if (commandType == 'get_session_info' &&
              messageData['data'] != null) {
            setState(() {
              _sessionInfo = messageData['data'] as Map<String, dynamic>;
              if (_sessionInfo!['currentSessionId'] != null) {
                _currentCursorSessionId =
                    _sessionInfo!['currentSessionId'] as String;
              }
              if (_sessionInfo!['clientId'] != null) {
                _currentClientId = _sessionInfo!['clientId'] as String;
              }
            });
          }
          // 대화 히스토리 조회 결과 처리 (Extension은 data에 배열 직접 또는 { entries: [] })
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
            setState(() {
              _chatHistory = entries;
              _availableSessions = _chatHistory
                  .map((entry) => entry['sessionId'] as String? ?? '')
                  .where((id) => id.isNotEmpty)
                  .toSet()
                  .toList();
              if (_loadingSessionHistoryForDisplay) {
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
            });
            if (entries.isEmpty) {
              if (_loadingSessionHistoryForDisplay) {
                setState(() => _loadingSessionHistoryForDisplay = false);
              }
              if (_loadingPastMessages) {
                setState(() => _loadingPastMessages = false);
              }
            }
          }

          // 일반 명령 성공 메시지는 세션/히스토리 조회 시에는 표시하지 않음
          if (commandType != 'get_session_info' &&
              commandType != 'get_chat_history') {
            _messages.add(
                MessageItem('✅ Command succeeded', type: MessageType.system));
          }
          if (commandType == 'stop_prompt') {
            _isWaitingForResponse = false;
          }
        } else {
          _messages.add(MessageItem('❌ Command failed: ${messageData['error']}',
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
        // 스트리밍 청크 처리
        final chunkText = messageData['text'] ?? '';
        final fullText = messageData['fullText'] ?? chunkText;
        final isReplace = messageData['isReplace'] == true;

        // 세션 ID 추출 및 저장
        if (messageData['sessionId'] != null) {
          setState(() {
            _currentCursorSessionId = messageData['sessionId'] as String;
          });
        }
        if (messageData['clientId'] != null) {
          final newClientId = messageData['clientId'] as String;
          setState(() {
            if (_currentClientId == null) {
              _currentClientId = newClientId;
              _loadSessionInfo();
              _loadChatHistory();
            } else if (_currentClientId != newClientId) {
              _currentClientId = newClientId;
              _loadSessionInfo();
              _loadChatHistory();
            }
          });
        }

        setState(() {
          // 첫 번째 청크인 경우 메시지 추가
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
            // 기존 스트리밍 메시지 업데이트
            if (isReplace) {
              _streamingText = fullText;
            } else {
              _streamingText += chunkText;
            }
            // 메시지 업데이트
            if (_streamingMessageIndex! < _messages.length) {
              _messages[_streamingMessageIndex!] = MessageItem(_streamingText,
                  type: MessageType.chatResponseChunk);
            }
          }
        });
        _scrollToBottom();
      } else if (type == 'chat_response_complete') {
        // 스트리밍 완료 처리
        setState(() {
          if (_streamingMessageIndex != null &&
              _streamingMessageIndex! < _messages.length) {
            // 스트리밍 메시지를 일반 chat_response로 변경
            _messages[_streamingMessageIndex!] =
                MessageItem(_streamingText, type: MessageType.chatResponse);
            _streamingMessageIndex = null;
            _streamingText = '';
          }
          // 세션 ID 추출 및 저장
          if (messageData['clientId'] != null) {
            final newClientId = messageData['clientId'] as String;
            if (_currentClientId == null || _currentClientId != newClientId) {
              _currentClientId = newClientId;
              _loadSessionInfo();
            }
            // 히스토리 새로고침
            Future.delayed(const Duration(milliseconds: 500), () {
              _loadChatHistory();
            });
          } else if (_currentClientId != null) {
            Future.delayed(const Duration(milliseconds: 500), () {
              _loadChatHistory();
            });
          }
          _isWaitingForResponse = false;
        });
        _scrollToBottom();
      } else if (type == 'chat_response') {
        // 기존 방식 (비스트리밍 응답) - 하위 호환성
        // 세션 ID 추출 및 저장
        if (messageData['sessionId'] != null) {
          setState(() {
            _currentCursorSessionId = messageData['sessionId'] as String;
          });
        }
        if (messageData['clientId'] != null) {
          final newClientId = messageData['clientId'] as String;
          setState(() {
            // clientId가 처음 설정되면 세션 정보 및 히스토리 조회
            if (_currentClientId == null) {
              _currentClientId = newClientId;
              _loadSessionInfo();
              _loadChatHistory();
            } else if (_currentClientId != newClientId) {
              // clientId가 변경된 경우
              _currentClientId = newClientId;
              _loadSessionInfo();
              _loadChatHistory();
            } else {
              // 같은 clientId면 히스토리만 새로고침
              Future.delayed(const Duration(milliseconds: 500), () {
                _loadChatHistory();
              });
            }
          });
        } else if (_currentClientId != null) {
          // clientId가 이미 있으면 응답 수신 후 히스토리만 새로고침
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
        // 자동 모드로 선택된 실제 모드 정보 (릴레이 서버 연결)
        final requestedMode = messageData['requestedMode'] ?? 'auto';
        final actualMode = messageData['actualMode'] ?? 'agent';
        final displayName = messageData['displayName'] ?? actualMode;


        if (mounted) {
          setState(() {
            // 자동 모드로 선택된 경우에만 표시
            if (requestedMode == 'auto' && _selectedAgentMode == 'auto') {
              _actualSelectedMode = actualMode;

              // 마지막 User Prompt의 모드 업데이트
              // 메시지 리스트에서 가장 최근 User Prompt 찾아서 업데이트
              bool found = false;
              for (int i = _messages.length - 1; i >= 0; i--) {
                if (_messages[i].type == MessageType.userPrompt) {
                  // agentMode가 null인 경우 (자동 모드로 전송된 경우) 업데이트
                  if (_messages[i].agentMode == null) {
                    final updatedItem = MessageItem(
                      _messages[i].text,
                      type: _messages[i].type,
                      agentMode: actualMode,
                    );
                    _messages[i] = updatedItem;
                    // _lastUserPrompt도 업데이트
                    if (_lastUserPrompt != null &&
                        _lastUserPrompt!.text == _messages[i].text) {
                      _lastUserPrompt = updatedItem;
                    }
                    found = true;
                    break;
                  }
                }
              }

              if (!found) {
              } else {
                // UI 강제 업데이트를 위해 스크롤
                Future.microtask(() {
                  if (mounted) {
                    _scrollToBottom();
                  }
                });
              }
            }
          });

          // 사용자에게 알림 (SnackBar)
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('🤖 Auto mode: $displayName'),
              duration: const Duration(seconds: 2),
              backgroundColor: Colors.blue.shade700,
            ),
          );
        }
      } else if (type == 'log') {
        // 실시간 로그 메시지 처리
        final logLevelStr = messageData['level'] ?? 'info';
        final logMessage = messageData['message'] ?? '';
        final logSource = messageData['source'] ?? 'unknown';
        final logError = messageData['error'];

        // 로그 레벨 파싱
        LogLevel parsedLogLevel;
        switch (logLevelStr) {
          case 'error':
            parsedLogLevel = LogLevel.error;
            break;
          case 'warn':
          case 'warning':
            parsedLogLevel = LogLevel.warning;
            break;
          default:
            parsedLogLevel = LogLevel.info;
        }

        String logPrefix = '';
        switch (logSource) {
          case 'extension':
            logPrefix = '🔌 [Extension]';
            break;
          case 'pc-server':
            logPrefix = '🖥️ [PC Server]';
            break;
          default:
            logPrefix = '📝 [Log]';
        }

        String logText = '$logPrefix $logMessage';
        if (logError != null) {
          logText += ' - Error: $logError';
        }

        setState(() {
          _messages.add(MessageItem(logText,
              type: MessageType.log, logLevel: parsedLogLevel));
        });
        _scrollToBottom();
      } else {
        _applyCdpInbound(
          messageData is Map<String, dynamic>
              ? messageData
              : Map<String, dynamic>.from(msg),
        );
      }
    });
    _scrollToBottom();
  }

  // 모드 이름을 사용자 친화적인 표시 이름으로 변환
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

  // 모드에 따른 아이콘 반환
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

  // 텍스트 내용을 분석하여 적절한 에이전트 모드 자동 선택 (Extension의 detectAgentMode와 동일한 로직)
  String? _detectAgentMode(String text) {
    final lowerText = text.toLowerCase();

    // Debug 모드 키워드
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
      // 버그 관련 키워드가 있지만, 단순 질문인지 확인
      if (lowerText.contains('why') ||
          lowerText.contains('what') ||
          lowerText.contains('how') ||
          lowerText.contains('?')) {
        // 질문 형태면 Ask 모드
        if (lowerText.contains('explain') ||
            lowerText.contains('understand') ||
            lowerText.contains('learn')) {
          return 'ask';
        }
      }
      return 'debug';
    }

    // Plan 모드 키워드
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
      // 복잡한 작업 키워드 확인
      const complexKeywords = [
        'multiple',
        'several',
        'many',
        'system',
        'module',
        'component',
        'project',
        '전체',
        '모든',
        '전반'
      ];
      if (complexKeywords.any((keyword) => lowerText.contains(keyword))) {
        return 'plan';
      }
      // "프로젝트 분석", "전체 분석" 같은 패턴도 Plan 모드
      if (lowerText.contains('analyze') ||
          lowerText.contains('analysis') ||
          lowerText.contains('분석')) {
        return 'plan';
      }
    }

    // Ask 모드 키워드 (질문, 학습, 탐색)
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

    // 기본값: Agent 모드 (코드 작성/수정 작업)
    return null; // null이면 기본 Agent 모드 사용
  }

  /// Human-readable connection status (also used for screen readers)
  String get _connectionStatusLabel {
    if (_isConnected) return 'Connected';
    if (_isReconnecting) return 'Reconnecting';
    if (_isConnecting) return 'Connecting';
    if (_lastConnectionError != null) return 'Connection failed';
    return 'Not Connected';
  }

  void _disconnect() {
    _stopPolling();
    _stopReconnect();

    // Close local WebSocket
    _localWebSocket?.sink.close();
    _localWebSocket = null;

    if (mounted) {
      setState(() {
        _isConnected = false;
        _isConnecting = false;
        _sessionId = null;
        _isReconnecting = false;
        _reconnectAttempts = 0;
        _pendingCommandApprovals = [];
        _recentCommandEvents = [];
        _loadingCommandApprovals = false;
        _loadingCommandEvents = false;
        _lastCommandMetaRefreshAt = null;
        _messages.add(MessageItem('Disconnected', type: MessageType.system));
      });
    }
  }

  // Schedule reconnection with exponential backoff
  void _scheduleReconnect() {
    if (_isReconnecting || _isConnected) return;

    const maxAttempts = 5;
    if (_reconnectAttempts >= maxAttempts) {
      setState(() {
        _isReconnecting = false;
        _messages.add(MessageItem(
            '❌ Reconnection failed after $maxAttempts attempts. Please reconnect manually.',
            type: MessageType.system));
      });
      return;
    }

    setState(() {
      _isReconnecting = true;
      _reconnectAttempts++;
    });

    // Exponential backoff: 2s, 4s, 8s, 16s, 32s
    final delay = Duration(seconds: 2 * (1 << (_reconnectAttempts - 1)));

    setState(() {
      _messages.add(MessageItem(
          '🔄 Reconnecting in ${delay.inSeconds}s... (attempt $_reconnectAttempts/$maxAttempts)',
          type: MessageType.system));
    });

    _reconnectTimer = Timer(delay, () {
      if (mounted && !_isConnected) {
        if (_connectionType == ConnectionType.local) {
          _connectToLocal();
        } else {
          final sessionId = _sessionIdController.text.trim();
          if (sessionId.isNotEmpty) {
            _connectToSession(sessionId);
          }
        }
      }
    });
  }

  // 재연결 중지
  void _stopReconnect() {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _isReconnecting = false;
  }

  // 수동 재연결
  void _manualReconnect() {
    _stopReconnect();
    _reconnectAttempts = 0;
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
    // 연결 상태 재확인
    _checkConnectionState();

    if (!_isConnected) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Not connected')),
        );
      }
      return;
    }

    try {
      // agentMode가 제공되지 않으면 선택된 모드 사용 (또는 auto)
      final mode = agentMode ?? _selectedAgentMode;
      final backend = agentBackend ?? _selectedAgentBackend;

      // 자동 모드이고 프롬프트인 경우 텍스트를 분석하여 모드 미리 감지
      String? finalModeForCommand;
      if (prompt == true && text != null && mode == 'auto') {
        final detectedMode = _detectAgentMode(text);
        finalModeForCommand = detectedMode ?? 'agent'; // 감지되지 않으면 기본 Agent 모드
      } else if (mode != 'auto') {
        finalModeForCommand = mode;
      }

      final commandData = {
        'type': type,
        'id': DateTime.now().millisecondsSinceEpoch.toString(),
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
        // 자동 모드일 때도 감지된 모드를 전달하여 히스토리에 저장되도록 함
        if (finalModeForCommand != null) 'agentMode': finalModeForCommand,
        if (backend.isNotEmpty) 'agentBackend': backend,
        if (requestId != null) 'requestId': requestId,
        if (historyId != null) 'historyId': historyId,
      };

      // 프롬프트 전송 시 사용자 프롬프트를 별도로 기록하고 응답 대기 상태 설정
      if (prompt == true && execute == true && text != null) {
        setState(() {
          _isWaitingForResponse = true;
          // 사용자 프롬프트를 별도 타입으로 추가 (선택된 모드와 함께)
          final promptItem = MessageItem(
            text,
            type: MessageType.userPrompt,
            agentMode: finalModeForCommand ?? mode, // 감지된 모드 또는 선택된 모드
          );
          _lastUserPrompt = promptItem;
          _messages.add(promptItem);

          // 디버깅: 모드 정보 출력
        });
      }

      if (_connectionType == ConnectionType.local) {
        // 로컬 서버로 메시지 전송 (WebSocket)
        if (_localWebSocket != null) {
          _localWebSocket!.sink.add(jsonEncode(commandData));
          if (mounted) {
            setState(() {
              _messages.add(MessageItem('✅ Message sent to local server',
                  type: MessageType.system));
            });
            _scrollToBottom();
          }
        } else {
          throw Exception('Local WebSocket not connected');
        }
      } else {
        // 릴레이 서버로 메시지 전송
        if (_sessionId == null) {
          throw Exception('Session ID is required for relay connection');
        }
        // '응답 대기 중' UI가 먼저 그려지도록 다음 프레임에서 전송
        WidgetsBinding.instance.addPostFrameCallback((_) async {
          if (!mounted || _sessionId == null) return;
          try {
            final response = await http.post(
              Uri.parse('$kRelayServerUrl/api/send'),
              headers: {'Content-Type': 'application/json'},
              body: jsonEncode({
                'sessionId': _sessionId,
                'deviceId': _deviceId,
                'deviceType': 'mobile',
                'type': type,
                'data': commandData,
              }),
            );

            if (mounted) {
              // 응답 파싱 실패 시에도 대기 상태 유지 (파싱 오류 ≠ 전송 실패)
              Map<String, dynamic>? responseData;
              if (response.body.isNotEmpty) {
                try {
                  responseData =
                      jsonDecode(response.body) as Map<String, dynamic>?;
                } catch (_) {
                  responseData = null;
                }
              }
              final success = response.statusCode == 200 &&
                  (responseData?['success'] == true);
              final responseMeta =
                  responseData?['data'] as Map<String, dynamic>? ?? {};
              final policyDecision =
                  responseMeta['policyDecision']?.toString() ?? '';
              final approvalId = responseMeta['approvalId']?.toString();
              final riskLevel = responseMeta['riskLevel']?.toString() ?? '';

              setState(() {
                if (success) {
                  _messages.add(MessageItem('✅ Message sent — waiting for response…',
                      type: MessageType.system));
                  // _isWaitingForResponse는 이미 true, 유지
                } else if (policyDecision == 'approval_required') {
                  _messages.add(MessageItem(
                      '⏳ Approval required: $approvalId (risk: $riskLevel)',
                      type: MessageType.system));
                  _isWaitingForResponse = false;
                } else if (policyDecision == 'deny') {
                  _messages.add(MessageItem(
                      '🚫 Policy blocked: ${responseData?['error'] ?? 'command denied'}',
                      type: MessageType.system));
                  _isWaitingForResponse = false;
                } else {
                  _messages.add(MessageItem(
                      '❌ Send failed: ${responseData?['error'] ?? 'HTTP ${response.statusCode}'}',
                      type: MessageType.system));
                  _isWaitingForResponse = false;
                }
              });

              if (policyDecision == 'approval_required') {
                _loadCommandApprovals(silent: true);
                _loadCommandEvents(silent: true);
              }
              _scrollToBottom();
            }
          } catch (e) {
            if (mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(content: Text('Send error: $e')),
              );
              setState(() {
                _isWaitingForResponse = false;
                _messages
                    .add(MessageItem('Send error: $e', type: MessageType.system));
              });
            }
          }
        });
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Send error: $e')),
        );
        setState(() {
          _isWaitingForResponse = false;
          _messages.add(MessageItem('Send error: $e', type: MessageType.system));
        });
      }
    }
  }

  void _scrollToBottom() {
    // 다음 프레임에서 스크롤 (위젯이 빌드된 후)
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
          // 스크롤 에러 무시
        }
      }
    });
  }

  Widget _buildMessageItem(MessageItem message) {
    // 구분선
    if (message.type == MessageType.chatResponseDivider) {
      return const Divider(
        height: 1,
        thickness: 2,
        color: Colors.blue,
      );
    }

    // 헤더
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

    // 채팅 응답 본문 (스트리밍 중)
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
                // 스트리밍 인디케이터
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
                    // 애니메이션 반복
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

    // 채팅 응답 본문 (완료)
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

    // 사용자 프롬프트 (입력한 내용) - 구분감 있게 표시
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
                // 에이전트 모드 표시 (null이 아니고 auto가 아닌 모든 경우, 자동 모드도 미리 감지되어 표시됨)
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

    // 로그 메시지 스타일
    if (message.type == MessageType.log) {
      // 로그 레벨에 따라 색상 결정
      Color logColor;
      IconData logIcon;

      switch (message.logLevel ?? LogLevel.info) {
        case LogLevel.error:
          logColor = Theme.of(context).colorScheme.error;
          logIcon = Icons.error;
        case LogLevel.warning:
          logColor = const Color(0xFFFF9800); // 오렌지
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

    // 시스템 메시지 스타일
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

    // 일반 메시지
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

  // 시스템 메시지 아이콘 결정
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

  // 시간 포맷팅
  String _formatTime(DateTime time) {
    return '${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}:${time.second.toString().padLeft(2, '0')}';
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _loadConnectionSettings();
    // 설정에서 기본 에이전트 모드 적용
    _selectedAgentMode = AppSettings().defaultAgentMode;
    // 설정 변경 리스너 추가
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
        // 설정 변경 시 UI 업데이트 (히스토리 표시 등)
      });
    }
  }

  // 입력창 클리어 (한글 IME composing 버퍼 완전 초기화)
  void _clearCommandInput() {
    // Controller 텍스트 클리어
    _commandController.clear();

    // Key를 변경하여 TextField 완전 재생성 (IME 상태 완전 리셋)
    setState(() {
      _textFieldKey++;
    });

    // 새 TextField에 포커스 요청
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _commandFocusNode.requestFocus();
      }
    });
  }

  // 연결 설정 로드 (SharedPreferences)
  Future<void> _loadConnectionSettings() async {
    try {
      final prefs = await SharedPreferences.getInstance();

      // 연결 타입 로드
      final connectionTypeStr = prefs.getString('connection_type');
      if (connectionTypeStr != null) {
        setState(() {
          _connectionType = connectionTypeStr == 'local'
              ? ConnectionType.local
              : ConnectionType.relay;
        });
      }

      // PC(Extension) IP 주소 로드
      final savedIp = prefs.getString('pc_server_ip');
      if (savedIp != null && savedIp.isNotEmpty) {
        _localIpController.text = savedIp;
      }
      final savedPort = prefs.getString('local_ws_port');
      if (savedPort != null && savedPort.isNotEmpty) {
        _localPortController.text = savedPort;
      }

      // 마지막 세션 ID 로드 (선택사항)
      final lastSessionId = prefs.getString('last_session_id');
      if (lastSessionId != null && lastSessionId.isNotEmpty) {
        _sessionIdController.text = lastSessionId;
      }
    } catch (e) {
      // 에러는 조용히 무시 (첫 실행 시 prefs가 없을 수 있음)
    }
  }

  // 연결 설정 저장 (SharedPreferences)
  Future<void> _saveConnectionSettings() async {
    try {
      final prefs = await SharedPreferences.getInstance();

      // 연결 타입 저장
      await prefs.setString('connection_type',
          _connectionType == ConnectionType.local ? 'local' : 'relay');

      // PC(Extension) IP 주소 저장
      if (_localIpController.text.trim().isNotEmpty) {
        await prefs.setString('pc_server_ip', _localIpController.text.trim());
      }
      if (_localPortController.text.trim().isNotEmpty) {
        await prefs.setString('local_ws_port', _localPortController.text.trim());
      }

      // 세션 ID 저장 (연결 성공 시)
      if (_sessionId != null && _sessionId!.isNotEmpty) {
        await prefs.setString('last_session_id', _sessionId!);
      }
    } catch (e) {
      // 에러는 조용히 무시
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    super.didChangeAppLifecycleState(state);
    if (state == AppLifecycleState.resumed) {
      // 앱이 다시 활성화되었을 때 연결 상태 확인 및 UI 갱신
      if (mounted) {
        // 연결 상태 확인
        _checkConnectionState();
        // UI 강제 갱신 - Future.microtask를 사용하여 다음 프레임에서 실행
        Future.microtask(() {
          if (mounted) {
            setState(() {
              // 상태 갱신으로 UI 다시 렌더링
            });
          }
        });
      }
    } else if (state == AppLifecycleState.paused) {
      // 앱이 백그라운드로 갔을 때는 특별한 처리가 필요 없음
    }
  }

  // 세션 정보 조회
  Future<void> _loadSessionInfo() async {
    if (!_isConnected) return;

    // clientId가 아직 없으면 잠시 대기 후 재시도
    if (_currentClientId == null) {
      Future.delayed(const Duration(milliseconds: 500), () {
        if (_isConnected) _loadSessionInfo();
      });
      return;
    }

    try {
      await _sendCommand('get_session_info', clientId: _currentClientId);
    } catch (e) {
      // 에러는 조용히 무시
    }
  }

  // 대화 히스토리 조회
  // 릴레이 모드일 때 relaySessionId를 넘기면 현재 릴레이 세션의 히스토리만 반환됨
  Future<void> _loadChatHistory({String? sessionId, int limit = 50}) async {
    if (!_isConnected) return;

    try {
      await _sendCommand('get_chat_history',
          clientId: _currentClientId,
          sessionId: sessionId ?? _currentCursorSessionId,
          relaySessionId: _sessionId, // 릴레이 모드: 현재 세션 히스토리만
          limit: limit);
    } catch (e) {
      // 에러는 조용히 무시
    }
  }

  Future<void> _refreshCommandMetaIfStale(
      {Duration minInterval = const Duration(seconds: 6)}) async {
    if (!_isConnected || _connectionType != ConnectionType.relay) return;
    final now = DateTime.now();
    if (_lastCommandMetaRefreshAt != null &&
        now.difference(_lastCommandMetaRefreshAt!) < minInterval) {
      return;
    }
    _lastCommandMetaRefreshAt = now;
    await _loadCommandApprovals(silent: true);
    await _loadCommandEvents(silent: true);
  }

  Future<void> _loadCommandApprovals({bool silent = false}) async {
    if (!_isConnected || _sessionId == null) return;
    if (_connectionType != ConnectionType.relay) return;
    if (_loadingCommandApprovals) return;

    if (mounted) {
      setState(() => _loadingCommandApprovals = true);
    }

    try {
      final uri = Uri.parse('$kRelayServerUrl/api/command-approvals')
          .replace(queryParameters: {'sessionId': _sessionId});
      final response = await http.get(uri);
      final body = response.body.isNotEmpty
          ? jsonDecode(response.body) as Map<String, dynamic>
          : <String, dynamic>{};

      if (!mounted) return;
      if (response.statusCode == 200 && body['success'] == true) {
        final data = body['data'] as Map<String, dynamic>? ?? {};
        final approvals =
            List<Map<String, dynamic>>.from((data['approvals'] as List? ?? [])
                .map((e) => Map<String, dynamic>.from(e as Map)));

        setState(() {
          _pendingCommandApprovals = approvals;
          _loadingCommandApprovals = false;
        });

        if (!silent) {
          setState(() {
            _messages.add(MessageItem('🔐 Pending approvals: ${approvals.length}',
                type: MessageType.system));
          });
          _scrollToBottom();
        }
      } else {
        setState(() => _loadingCommandApprovals = false);
        if (!silent) {
          setState(() {
            _messages.add(MessageItem(
                '❌ Failed to load approvals: ${body['error'] ?? 'HTTP ${response.statusCode}'}',
                type: MessageType.system));
          });
          _scrollToBottom();
        }
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _loadingCommandApprovals = false);
      if (!silent) {
        setState(() {
          _messages.add(
              MessageItem('❌ Failed to load approvals: $e', type: MessageType.system));
        });
        _scrollToBottom();
      }
    }
  }

  Future<void> _loadCommandEvents({int limit = 20, bool silent = false}) async {
    if (!_isConnected || _sessionId == null) return;
    if (_connectionType != ConnectionType.relay) return;
    if (_loadingCommandEvents) return;

    if (mounted) {
      setState(() => _loadingCommandEvents = true);
    }

    try {
      final uri = Uri.parse('$kRelayServerUrl/api/command-events').replace(
          queryParameters: {'sessionId': _sessionId, 'limit': '$limit'});
      final response = await http.get(uri);
      final body = response.body.isNotEmpty
          ? jsonDecode(response.body) as Map<String, dynamic>
          : <String, dynamic>{};

      if (!mounted) return;
      if (response.statusCode == 200 && body['success'] == true) {
        final data = body['data'] as Map<String, dynamic>? ?? {};
        final events =
            List<Map<String, dynamic>>.from((data['events'] as List? ?? [])
                .map((e) => Map<String, dynamic>.from(e as Map)));
        setState(() {
          _recentCommandEvents = events;
          _loadingCommandEvents = false;
        });

        if (!silent) {
          setState(() {
            _messages.add(MessageItem('📚 Command events: ${events.length}',
                type: MessageType.system));
          });
          _scrollToBottom();
        }
      } else {
        setState(() => _loadingCommandEvents = false);
        if (!silent) {
          setState(() {
            _messages.add(MessageItem(
                '❌ Failed to load command events: ${body['error'] ?? 'HTTP ${response.statusCode}'}',
                type: MessageType.system));
          });
          _scrollToBottom();
        }
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _loadingCommandEvents = false);
      if (!silent) {
        setState(() {
          _messages.add(MessageItem('❌ Failed to load command events: $e',
              type: MessageType.system));
        });
        _scrollToBottom();
      }
    }
  }

  Future<void> _resolveCommandApproval(String approvalId, String action) async {
    if (!_isConnected || _sessionId == null) return;
    if (_connectionType != ConnectionType.relay) return;

    try {
      final response = await http.post(
        Uri.parse('$kRelayServerUrl/api/resolve-command-approval'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'sessionId': _sessionId,
          'approvalId': approvalId,
          'action': action,
          'resolvedBy': _deviceId,
          'reason': 'resolved via mobile app',
        }),
      );
      final body = response.body.isNotEmpty
          ? jsonDecode(response.body) as Map<String, dynamic>
          : <String, dynamic>{};

      if (!mounted) return;
      if (response.statusCode == 200 && body['success'] == true) {
        final status =
            (body['data'] as Map<String, dynamic>? ?? {})['status'] ?? action;
        setState(() {
          _messages.add(MessageItem('✅ Approval resolved: $approvalId → $status',
              type: MessageType.system));
        });
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Approval $action completed')),
        );
        _scrollToBottom();
        await _loadCommandApprovals(silent: true);
        await _loadCommandEvents(silent: true);
      } else {
        setState(() {
          _messages.add(MessageItem(
              '❌ Failed to resolve approval: ${body['error'] ?? 'HTTP ${response.statusCode}'}',
              type: MessageType.system));
        });
        _scrollToBottom();
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _messages.add(
            MessageItem('❌ Failed to resolve approval: $e', type: MessageType.system));
      });
      _scrollToBottom();
    }
  }

  Color _riskColor(String? riskLevel) {
    switch (riskLevel) {
      case 'critical':
        return Colors.red;
      case 'high':
        return Colors.orange;
      case 'medium':
        return Colors.amber.shade700;
      default:
        return Colors.blueGrey;
    }
  }

  /// 대화 메시지만 제거 (시스템/로그 메시지는 유지) - 현재 세션만 표시할 때 사용
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

  /// get_chat_history 응답 entries를 메인 메시지 목록(_messages)에 반영
  /// [skipIfExists] true면 이미 같은 userMessage가 있으면 해당 entry 건너뜀 (중복 방지)
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

  // 연결 상태 확인 및 필요시 재연결
  void _checkConnectionState() {
    if (_connectionType == ConnectionType.local) {
      // 로컬 연결: WebSocket 상태 확인
      if (_localWebSocket == null && _isConnected) {
        if (mounted) {
          setState(() {
            _isConnected = false;
            _messages.add(MessageItem(
                '⚠️ Local connection lost, please reconnect',
                type: MessageType.system));
          });
        }
      }
    } else {
      // 릴레이 연결: 세션 ID 확인
      if (_sessionId == null && _isConnected) {
        // 세션이 null인데 연결 상태가 true면 상태 불일치
        if (mounted) {
          setState(() {
            _isConnected = false;
            _messages.add(MessageItem('⚠️ Connection lost, please reconnect',
                type: MessageType.system));
          });
        }
      } else if (_sessionId != null && !_isConnected) {
        // 세션이 있는데 연결 상태가 false면 상태 불일치
        if (mounted) {
          setState(() {
            _isConnected = true;
          });
        }
      }
    }
  }

  @override
  void dispose() {
    _scrollController.removeListener(_updateScrollButtonVisibility);
    WidgetsBinding.instance.removeObserver(this);
    AppSettings().removeListener(_onAppSettingsChanged);
    _stopPolling();
    _stopReconnect(); // Phase 5: cancel reconnect timer to prevent post-dispose callbacks
    _localWebSocket?.sink.close();
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

  /// 메시지 리스트 위젯 (필터·검색 적용된 목록, 컴팩트/일반 뷰 공용)
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

  /// 메시지 리스트 + 맨 위/맨 아래 스크롤 버튼 (스크롤 가능할 때만, 위/아래 각각 배치)
  Widget _buildMessageListWithScrollButtons() {
    WidgetsBinding.instance
        .addPostFrameCallback((_) => _updateScrollButtonVisibility());
    return Stack(
      children: [
        _buildMessageList(),
        // 맨 위로: 상단 오른쪽, 위로 스크롤 가능할 때만
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
        // 맨 아래로: 하단 오른쪽, 아래로 스크롤 가능할 때만
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

  /// 컴팩트 뷰: 메시지 영역 크게 + 한줄 프롬프트만 (앱바 아이콘으로 전체 화면 복귀)
  Widget _buildCompactBody() {
    return Column(
      children: [
        Expanded(
          child: _selectedAgentBackend == 'cdp'
              ? AgentControlCenter(
                  connected: _isConnected,
                  store: _cdpStore,
                  onRefresh: _refreshCdpSessions,
                  onReconnect: () {
                    _stopReconnect();
                    _connect();
                  },
                  sendCommand: _sendCdpControlCommand,
                )
              : _buildMessageListWithScrollButtons(),
        ),
        if (_selectedAgentBackend != 'cdp')
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
                  if (v == 'cdp') _refreshCdpSessions();
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
                        : 'Relay'),
              ),
            ),
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
                  builder: (context) => const SettingsPage(),
                ),
              );
            },
          ),
          const SizedBox(width: 6),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(height: 1, color: Cr.borderSubtle),
        ),
      ),
      body: SafeArea(
        child: _isCompactView && _isConnected
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
                                    gradient: LinearGradient(
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
                              // 로컬 서버 연결 UI
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
                              // 최근 연결 목록
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
                              // 재연결 중 상태 표시
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
                              // 연결 에러 표시
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
                              child: AgentControlCenter(
                                connected: _isConnected,
                                store: _cdpStore,
                                onRefresh: _refreshCdpSessions,
                                onReconnect: () {
                                  _stopReconnect();
                                  _connect();
                                },
                                sendCommand: _sendCdpControlCommand,
                              ),
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
                                        const Color(0xFFFFF3E0), // 오렌지 배경
                                    checkmarkColor:
                                        const Color(0xFFFF9800), // 오렌지
                                    onSelected: (selected) {
                                      setState(() {
                                        _activeFilters[MessageFilter.log] =
                                            selected;
                                        // 로그 필터 활성화 시 레벨 필터 모두 체크
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
                                  // 로그 레벨 필터 (로그 필터 활성화 시에만 표시)
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
                          // 에이전트 모드 선택
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
                                          // 사용자가 직접 모드를 선택하면 실제 모드 표시 초기화
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
                          // 자동 모드로 선택된 경우 실제 모드 표시
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
                          // KeyboardListener: Enter 전송. 컨트롤러에서 읽고 debounce + 전송 후 한 프레임 뒤 재정리로 IME 중복 전송 방지.
                          // (Focus+동일 FocusNode는 focus_manager assertion 유발로 사용 안 함)
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
                            // ValueListenableBuilder로 입력창 감싸기 (전체 UI 리빌드 방지)
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
                          // 버튼 영역도 ValueListenableBuilder로 감싸기
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
                          // 세션 정보 및 대화 히스토리 표시 (설정에서 활성화한 경우만)
                          if (_isConnected && AppSettings().showHistory) ...[
                            // 현재 세션 정보
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

                            // 세션 목록 및 대화 히스토리
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
                                    // 세션 목록
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

                                    // 대화 히스토리
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

                                            // 디버깅: 모든 항목 로그 출력 (문제 확인용)

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
                                                            // 에이전트 모드 표시 (null이 아니고 비어있지 않은 경우, auto도 표시)
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

                                    // 새로고침 버튼
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
                            Container(
                              margin: const EdgeInsets.only(top: 8.0),
                              child: Card(
                                child: ExpansionTile(
                                  title: Text(
                                    'Command approvals & events',
                                    style: TextStyle(
                                      fontSize: 15,
                                      fontWeight: FontWeight.w600,
                                      color: Theme.of(context)
                                          .colorScheme
                                          .onSurface,
                                    ),
                                  ),
                                  subtitle: Text(
                                    'pending: ${_pendingCommandApprovals.length}',
                                    style: TextStyle(
                                      fontSize: 12,
                                      color: Theme.of(context)
                                          .colorScheme
                                          .onSurfaceVariant,
                                    ),
                                  ),
                                  leading: Container(
                                    padding: const EdgeInsets.all(6),
                                    decoration: BoxDecoration(
                                      color: Theme.of(context)
                                          .colorScheme
                                          .tertiaryContainer,
                                      borderRadius: BorderRadius.circular(8),
                                    ),
                                    child: Icon(
                                      Icons.security,
                                      size: 18,
                                      color: Theme.of(context)
                                          .colorScheme
                                          .onTertiaryContainer,
                                    ),
                                  ),
                                  children: [
                                    Padding(
                                      padding: const EdgeInsets.symmetric(
                                          horizontal: 12, vertical: 8),
                                      child: Row(
                                        children: [
                                          OutlinedButton.icon(
                                            onPressed: _isConnected
                                                ? () {
                                                    _loadCommandApprovals();
                                                    _loadCommandEvents();
                                                  }
                                                : null,
                                            icon: const Icon(Icons.refresh,
                                                size: 16),
                                            label: const Text('Refresh'),
                                          ),
                                          const SizedBox(width: 8),
                                          if (_loadingCommandApprovals ||
                                              _loadingCommandEvents)
                                            const SizedBox(
                                              width: 16,
                                              height: 16,
                                              child: CircularProgressIndicator(
                                                  strokeWidth: 2),
                                            ),
                                        ],
                                      ),
                                    ),
                                    Padding(
                                      padding: const EdgeInsets.symmetric(
                                          horizontal: 12, vertical: 4),
                                      child: Align(
                                        alignment: Alignment.centerLeft,
                                        child: Text(
                                          'Pending approvals',
                                          style: TextStyle(
                                            fontSize: 13,
                                            fontWeight: FontWeight.w600,
                                            color: Theme.of(context)
                                                .colorScheme
                                                .onSurface,
                                          ),
                                        ),
                                      ),
                                    ),
                                    if (_pendingCommandApprovals.isEmpty)
                                      Padding(
                                        padding: const EdgeInsets.fromLTRB(
                                            12, 0, 12, 8),
                                        child: Align(
                                          alignment: Alignment.centerLeft,
                                          child: Text(
                                            'No pending approvals.',
                                            style: TextStyle(
                                              fontSize: 12,
                                              color: Theme.of(context)
                                                  .colorScheme
                                                  .onSurfaceVariant,
                                            ),
                                          ),
                                        ),
                                      )
                                    else
                                      ..._pendingCommandApprovals
                                          .take(5)
                                          .map((approval) {
                                        final approvalId =
                                            approval['approval_id']
                                                    ?.toString() ??
                                                '';
                                        final commandMessage =
                                            approval['command_message']
                                                    as Map<String, dynamic>? ??
                                                {};
                                        final commandData =
                                            commandMessage['data']
                                                    as Map<String, dynamic>? ??
                                                {};
                                        final commandRaw =
                                            commandData['command']
                                                    ?.toString() ??
                                                '(unknown)';
                                        final policy = approval['policy']
                                                as Map<String, dynamic>? ??
                                            {};
                                        final riskLevel =
                                            policy['risk_level']?.toString() ??
                                                'unknown';
                                        final reasons = (policy['reasons']
                                                    as List? ??
                                                [])
                                            .map((e) => e.toString())
                                            .join(', ');
                                        return Card(
                                          margin: const EdgeInsets.fromLTRB(
                                              12, 4, 12, 4),
                                          elevation: 0,
                                          shape: RoundedRectangleBorder(
                                            borderRadius:
                                                BorderRadius.circular(10),
                                            side: BorderSide(
                                              color: Theme.of(context)
                                                  .colorScheme
                                                  .outline
                                                  .withValues(alpha: 0.2),
                                            ),
                                          ),
                                          child: Padding(
                                            padding: const EdgeInsets.all(10),
                                            child: Column(
                                              crossAxisAlignment:
                                                  CrossAxisAlignment.start,
                                              children: [
                                                Row(
                                                  children: [
                                                    Expanded(
                                                      child: Text(
                                                        commandRaw,
                                                        style: const TextStyle(
                                                          fontSize: 12,
                                                          fontFamily:
                                                              'monospace',
                                                          fontWeight:
                                                              FontWeight.w600,
                                                        ),
                                                      ),
                                                    ),
                                                    Container(
                                                      padding: const EdgeInsets
                                                          .symmetric(
                                                          horizontal: 8,
                                                          vertical: 2),
                                                      decoration: BoxDecoration(
                                                        color: _riskColor(
                                                                riskLevel)
                                                            .withValues(alpha: 0.14),
                                                        borderRadius:
                                                            BorderRadius
                                                                .circular(12),
                                                      ),
                                                      child: Text(
                                                        riskLevel,
                                                        style: TextStyle(
                                                          fontSize: 10,
                                                          fontWeight:
                                                              FontWeight.w700,
                                                          color: _riskColor(
                                                              riskLevel),
                                                        ),
                                                      ),
                                                    ),
                                                  ],
                                                ),
                                                if (reasons.isNotEmpty) ...[
                                                  const SizedBox(height: 4),
                                                  Text(
                                                    reasons,
                                                    style: TextStyle(
                                                      fontSize: 11,
                                                      color: Theme.of(context)
                                                          .colorScheme
                                                          .onSurfaceVariant,
                                                    ),
                                                  ),
                                                ],
                                                const SizedBox(height: 8),
                                                Row(
                                                  children: [
                                                    Expanded(
                                                      child: OutlinedButton(
                                                        onPressed: () {
                                                          _resolveCommandApproval(
                                                              approvalId,
                                                              'reject');
                                                        },
                                                        child:
                                                            const Text('Reject'),
                                                      ),
                                                    ),
                                                    const SizedBox(width: 8),
                                                    Expanded(
                                                      child: FilledButton(
                                                        onPressed: () {
                                                          _resolveCommandApproval(
                                                              approvalId,
                                                              'approve');
                                                        },
                                                        child:
                                                            const Text('Approve'),
                                                      ),
                                                    ),
                                                  ],
                                                ),
                                              ],
                                            ),
                                          ),
                                        );
                                      }),
                                    const Divider(height: 20),
                                    Padding(
                                      padding: const EdgeInsets.symmetric(
                                          horizontal: 12, vertical: 4),
                                      child: Align(
                                        alignment: Alignment.centerLeft,
                                        child: Text(
                                          'Recent command events',
                                          style: TextStyle(
                                            fontSize: 13,
                                            fontWeight: FontWeight.w600,
                                            color: Theme.of(context)
                                                .colorScheme
                                                .onSurface,
                                          ),
                                        ),
                                      ),
                                    ),
                                    if (_recentCommandEvents.isEmpty)
                                      Padding(
                                        padding: const EdgeInsets.fromLTRB(
                                            12, 0, 12, 12),
                                        child: Align(
                                          alignment: Alignment.centerLeft,
                                          child: Text(
                                            'No command events to show.',
                                            style: TextStyle(
                                              fontSize: 12,
                                              color: Theme.of(context)
                                                  .colorScheme
                                                  .onSurfaceVariant,
                                            ),
                                          ),
                                        ),
                                      )
                                    else
                                      ..._recentCommandEvents
                                          .take(5)
                                          .map((event) {
                                        final result = event['result']
                                                as Map<String, dynamic>? ??
                                            {};
                                        final command = event['command']
                                                as Map<String, dynamic>? ??
                                            {};
                                        final approval = event['approval']
                                                as Map<String, dynamic>? ??
                                            {};
                                        final risk = event['risk']
                                                as Map<String, dynamic>? ??
                                            {};
                                        final status =
                                            result['status']?.toString() ??
                                                'unknown';
                                        final raw = command['raw']
                                                ?.toString() ??
                                            '(unknown)';
                                        final approvalStatus =
                                            approval['status']?.toString() ??
                                                'not_required';
                                        final riskLevel =
                                            risk['level']?.toString() ?? 'low';
                                        Color statusColor;
                                        switch (status) {
                                          case 'success':
                                            statusColor = Colors.green;
                                            break;
                                          case 'error':
                                          case 'cancelled':
                                            statusColor = Colors.red;
                                            break;
                                          default:
                                            statusColor = Colors.orange;
                                        }

                                        return ListTile(
                                          dense: true,
                                          leading: Icon(Icons.bolt,
                                              size: 16, color: statusColor),
                                          title: Text(
                                            '$status • $raw',
                                            style:
                                                const TextStyle(fontSize: 12),
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                          ),
                                          subtitle: Text(
                                            'risk: $riskLevel · approval: $approvalStatus',
                                            style:
                                                const TextStyle(fontSize: 11),
                                          ),
                                        );
                                      }),
                                    const SizedBox(height: 8),
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
  const SettingsPage({super.key});

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
                  child: CrSectionLabel('Appearance'),
                ),
                _buildThemeModeTile(),
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
                  child: CrSectionLabel('Features'),
                ),
                _buildShowHistoryTile(),
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

  Widget _buildThemeModeTile() {
    return ListTile(
      leading: Container(
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(
          color: Cr.accentSoft,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Icon(
          _getThemeIcon(_settings.themeMode),
          color: Cr.accent,
          size: 20,
        ),
      ),
      title: const Text('Theme'),
      subtitle: Text(_getThemeModeLabel(_settings.themeMode)),
      trailing: const Icon(Icons.chevron_right, color: Cr.textFaint),
      onTap: () => _showThemeModeDialog(),
    );
  }

  IconData _getThemeIcon(ThemeModeSetting mode) {
    switch (mode) {
      case ThemeModeSetting.light:
        return Icons.light_mode;
      case ThemeModeSetting.dark:
        return Icons.dark_mode;
      case ThemeModeSetting.system:
        return Icons.brightness_auto;
    }
  }

  String _getThemeModeLabel(ThemeModeSetting mode) {
    switch (mode) {
      case ThemeModeSetting.light:
        return 'Light';
      case ThemeModeSetting.dark:
        return 'Dark';
      case ThemeModeSetting.system:
        return 'System default';
    }
  }

  void _showThemeModeDialog() {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Select Theme'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: ThemeModeSetting.values.map((mode) {
            return RadioListTile<ThemeModeSetting>(
              title: Row(
                children: [
                  Icon(_getThemeIcon(mode), size: 20),
                  const SizedBox(width: 12),
                  Text(_getThemeModeLabel(mode)),
                ],
              ),
              value: mode,
              // ignore: deprecated_member_use
              groupValue: _settings.themeMode,
              // ignore: deprecated_member_use
              onChanged: (value) {
                if (value != null) {
                  _settings.setThemeMode(value);
                  Navigator.of(context).pop();
                }
              },
            );
          }).toList(),
        ),
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
          '© 2026 jaloveeye',
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
