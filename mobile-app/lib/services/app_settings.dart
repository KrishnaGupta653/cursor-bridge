import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/connection_models.dart';

class AppSettings extends ChangeNotifier {
  static final AppSettings _instance = AppSettings._internal();
  factory AppSettings() => _instance;
  AppSettings._internal();

  // 설정 키 (an old 'theme_mode' value may still be saved; the app is dark-only and ignores it)
  static const String _keyShowHistory = 'show_history';
  static const String _keyDefaultAgentMode = 'default_agent_mode';
  static const String _keyConnectionHistory = 'connection_history';

  // 최대 히스토리 개수
  static const int _maxHistoryCount = 5;

  // 현재 설정값
  bool _showHistory = false; // 기본값: 숨김
  String _defaultAgentMode = 'auto';
  List<ConnectionHistoryItem> _connectionHistory = [];

  // getters
  bool get showHistory => _showHistory;
  String get defaultAgentMode => _defaultAgentMode;
  List<ConnectionHistoryItem> get connectionHistory =>
      List.unmodifiable(_connectionHistory);

  // 설정 로드
  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();

    // 히스토리 표시
    _showHistory = prefs.getBool(_keyShowHistory) ?? false;

    // 기본 에이전트 모드
    _defaultAgentMode = prefs.getString(_keyDefaultAgentMode) ?? 'auto';

    // 연결 히스토리
    final historyJson = prefs.getString(_keyConnectionHistory);
    if (historyJson != null && historyJson.isNotEmpty) {
      _connectionHistory = parseConnectionHistory(historyJson);
    }

    notifyListeners();
  }

  // 히스토리 표시 설정
  Future<void> setShowHistory(bool value) async {
    _showHistory = value;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_keyShowHistory, value);
    notifyListeners();
  }

  // 기본 에이전트 모드 설정
  Future<void> setDefaultAgentMode(String mode) async {
    _defaultAgentMode = mode;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_keyDefaultAgentMode, mode);
    notifyListeners();
  }

  // 연결 히스토리에 추가
  Future<void> addConnectionHistory(ConnectionHistoryItem item) async {
    // 동일한 연결이 있으면 제거 (최신으로 갱신하기 위해)
    _connectionHistory.removeWhere((h) => h.isSameConnection(item));

    // 맨 앞에 추가
    _connectionHistory.insert(0, item);

    // 최대 개수 유지
    if (_connectionHistory.length > _maxHistoryCount) {
      _connectionHistory = _connectionHistory.sublist(0, _maxHistoryCount);
    }

    // 저장
    await _saveConnectionHistory();
    notifyListeners();
  }

  // 연결 히스토리 저장
  Future<void> _saveConnectionHistory() async {
    final prefs = await SharedPreferences.getInstance();
    final historyJson =
        jsonEncode(_connectionHistory.map((h) => h.toJson()).toList());
    await prefs.setString(_keyConnectionHistory, historyJson);
  }

  // 연결 히스토리 삭제
  Future<void> removeConnectionHistory(ConnectionHistoryItem item) async {
    _connectionHistory.removeWhere((h) => h.isSameConnection(item));
    await _saveConnectionHistory();
    notifyListeners();
  }

  // 연결 히스토리 전체 삭제
  Future<void> clearConnectionHistory() async {
    _connectionHistory.clear();
    await _saveConnectionHistory();
    notifyListeners();
  }
}
