import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/connection_models.dart';

class AppSettings extends ChangeNotifier {
  static final AppSettings _instance = AppSettings._internal();
  factory AppSettings() => _instance;
  AppSettings._internal();

  // Preference keys (an old 'theme_mode' value may still be saved; the app is dark-only and ignores it)
  static const String _keyShowHistory = 'show_history';
  static const String _keyDefaultAgentMode = 'default_agent_mode';
  static const String _keyConnectionHistory = 'connection_history';

  // Maximum number of history entries
  static const int _maxHistoryCount = 5;

  // Current values
  bool _showHistory = false; // hidden by default
  String _defaultAgentMode = 'auto';
  List<ConnectionHistoryItem> _connectionHistory = [];

  // getters
  bool get showHistory => _showHistory;
  String get defaultAgentMode => _defaultAgentMode;
  List<ConnectionHistoryItem> get connectionHistory =>
      List.unmodifiable(_connectionHistory);

  // Load settings
  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();

    _showHistory = prefs.getBool(_keyShowHistory) ?? false;

    _defaultAgentMode = prefs.getString(_keyDefaultAgentMode) ?? 'auto';

    final historyJson = prefs.getString(_keyConnectionHistory);
    if (historyJson != null && historyJson.isNotEmpty) {
      _connectionHistory = parseConnectionHistory(historyJson);
    }

    notifyListeners();
  }

  Future<void> setShowHistory(bool value) async {
    _showHistory = value;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_keyShowHistory, value);
    notifyListeners();
  }

  Future<void> setDefaultAgentMode(String mode) async {
    _defaultAgentMode = mode;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_keyDefaultAgentMode, mode);
    notifyListeners();
  }

  // Add to connection history
  Future<void> addConnectionHistory(ConnectionHistoryItem item) async {
    // Drop an existing entry for the same connection so it moves to the front
    _connectionHistory.removeWhere((h) => h.isSameConnection(item));

    _connectionHistory.insert(0, item);

    // Cap the list length
    if (_connectionHistory.length > _maxHistoryCount) {
      _connectionHistory = _connectionHistory.sublist(0, _maxHistoryCount);
    }

    await _saveConnectionHistory();
    notifyListeners();
  }

  Future<void> _saveConnectionHistory() async {
    final prefs = await SharedPreferences.getInstance();
    final historyJson =
        jsonEncode(_connectionHistory.map((h) => h.toJson()).toList());
    await prefs.setString(_keyConnectionHistory, historyJson);
  }

  // Remove one connection history entry
  Future<void> removeConnectionHistory(ConnectionHistoryItem item) async {
    _connectionHistory.removeWhere((h) => h.isSameConnection(item));
    await _saveConnectionHistory();
    notifyListeners();
  }

  // Clear all connection history
  Future<void> clearConnectionHistory() async {
    _connectionHistory.clear();
    await _saveConnectionHistory();
    notifyListeners();
  }
}
