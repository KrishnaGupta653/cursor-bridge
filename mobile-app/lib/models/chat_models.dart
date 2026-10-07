/// Agents-window chats as the extension reports them (`chats`, `chat`,
/// `chat_delta`, `composer_state`, `file_diff`).
library;

String _str(dynamic v) => v == null ? '' : v.toString();
int _int(dynamic v) => v is int ? v : (v is num ? v.toInt() : int.tryParse(_str(v)) ?? 0);

/// One sidebar row: a chat in Cursor's Agents window, or a transcript-only chat.
class ChatRow {
  final String id;
  final String title;
  final String time;
  final String group;
  final bool pinned;

  /// running | waiting | error | draft | done | unknown
  final String status;
  final bool unread;
  final bool active;
  final String repoName;
  final DateTime? updatedAt;
  final bool inSidebar;

  const ChatRow({
    required this.id,
    required this.title,
    this.time = '',
    this.group = '',
    this.pinned = false,
    this.status = 'done',
    this.unread = false,
    this.active = false,
    this.repoName = '',
    this.updatedAt,
    this.inSidebar = false,
  });

  factory ChatRow.fromJson(Map<String, dynamic> j) => ChatRow(
        id: _str(j['id']),
        title: _str(j['title']).isEmpty ? 'Untitled chat' : _str(j['title']),
        time: _str(j['time']),
        group: _str(j['group']).isNotEmpty ? _str(j['group']) : _str(j['repoName']),
        pinned: j['pinned'] == true,
        status: _str(j['status']).isEmpty ? 'done' : _str(j['status']),
        unread: j['unread'] == true,
        active: j['active'] == true,
        repoName: _str(j['repoName']),
        updatedAt: DateTime.tryParse(_str(j['updatedAt'])),
        inSidebar: j['inSidebar'] == true,
      );

  bool get running => status == 'running';
  bool get waiting => status == 'waiting';

  /// Sidebar time label: Cursor's own when shown there, else relative to now.
  String timeLabel([DateTime? now]) {
    if (time.isNotEmpty) return time;
    final at = updatedAt;
    if (at == null) return '';
    final d = (now ?? DateTime.now()).difference(at);
    if (d.inMinutes < 1) return 'now';
    if (d.inHours < 1) return '${d.inMinutes}m';
    if (d.inDays < 1) return '${d.inHours}h';
    if (d.inDays < 7) return '${d.inDays}d';
    return '${(d.inDays / 7).floor()}w';
  }
}

class SidebarSection {
  final String name;
  final bool pinned;
  final List<ChatRow> rows;
  const SidebarSection(this.name, this.rows, {this.pinned = false});
}

/// Pinned first, then one section per repository in the order rows arrive
/// (Cursor's sidebar order, then transcript-only chats by recency).
List<SidebarSection> groupChats(List<ChatRow> rows, {String query = ''}) {
  final q = query.trim().toLowerCase();
  final visible = q.isEmpty
      ? rows
      : rows
          .where((r) =>
              r.title.toLowerCase().contains(q) ||
              r.group.toLowerCase().contains(q))
          .toList();
  final pinned = visible.where((r) => r.pinned).toList();
  final byGroup = <String, List<ChatRow>>{};
  for (final r in visible) {
    if (r.pinned) continue;
    byGroup.putIfAbsent(r.group.isEmpty ? 'Other' : r.group, () => []).add(r);
  }
  return [
    if (pinned.isNotEmpty) SidebarSection('Pinned', pinned, pinned: true),
    for (final e in byGroup.entries) SidebarSection(e.key, e.value),
  ];
}

class FileEdit {
  final String path;

  /// added | modified | deleted
  final String kind;
  final int added;
  final int removed;
  const FileEdit({required this.path, this.kind = 'modified', this.added = 0, this.removed = 0});

  factory FileEdit.fromJson(Map<String, dynamic> j) => FileEdit(
        path: _str(j['path']),
        kind: _str(j['kind']).isEmpty ? 'modified' : _str(j['kind']),
        added: _int(j['added']),
        removed: _int(j['removed']),
      );

  String get name => path.split('/').where((p) => p.isNotEmpty).lastOrNull ?? path;
}

class WorkSummary {
  final String summary;
  final List<FileEdit> edits;
  final List<String> commands;
  final int reads;
  final int searches;
  final List<String> notes;
  const WorkSummary({
    required this.summary,
    this.edits = const [],
    this.commands = const [],
    this.reads = 0,
    this.searches = 0,
    this.notes = const [],
  });

  factory WorkSummary.fromJson(Map<String, dynamic> j) => WorkSummary(
        summary: _str(j['summary']),
        edits: (j['edits'] as List? ?? const [])
            .whereType<Map>()
            .map((e) => FileEdit.fromJson(Map<String, dynamic>.from(e)))
            .toList(),
        commands: (j['commands'] as List? ?? const []).map(_str).toList(),
        reads: _int(j['reads']),
        searches: _int(j['searches']),
        notes: (j['notes'] as List? ?? const []).map(_str).toList(),
      );
}

class ChatItem {
  final int seq;
  final String id;

  /// user | assistant | work
  final String role;
  final String text;
  final String? timestamp;
  final WorkSummary? work;
  const ChatItem({
    required this.seq,
    required this.id,
    required this.role,
    this.text = '',
    this.timestamp,
    this.work,
  });

  factory ChatItem.fromJson(Map<String, dynamic> j) => ChatItem(
        seq: _int(j['seq']),
        id: _str(j['id']),
        role: _str(j['role']),
        text: _str(j['text']),
        timestamp: j['timestamp'] == null ? null : _str(j['timestamp']),
        work: j['work'] is Map ? WorkSummary.fromJson(Map<String, dynamic>.from(j['work'])) : null,
      );
}

/// Items of one chat, kept sorted by `seq`; deltas replace from `fromSeq` on.
class ChatThread {
  final String chatId;
  String title;
  String repoName;
  List<ChatItem> items;
  int total;
  bool hasOlder;
  List<FileEdit> filesChanged;
  bool loading;
  bool loadingOlder = false;

  ChatThread({
    required this.chatId,
    this.title = '',
    this.repoName = '',
    this.items = const [],
    this.total = 0,
    this.hasOlder = false,
    this.filesChanged = const [],
    this.loading = false,
  });

  int? get firstSeq => items.isEmpty ? null : items.first.seq;

  /// Returns false, changing nothing, when items between what we hold and [fromSeq] are missing.
  bool applyDelta(int fromSeq, int newTotal, List<ChatItem> delta) {
    final next = items.isEmpty ? 0 : items.last.seq + 1;
    if (fromSeq > next && (items.isNotEmpty || total > 0)) return false;
    items = [
      ...items.where((i) => i.seq < fromSeq),
      ...delta,
    ]..sort((a, b) => a.seq.compareTo(b.seq));
    total = newTotal;
    final edits = <String, FileEdit>{for (final f in filesChanged) f.path: f};
    for (final item in delta) {
      for (final e in item.work?.edits ?? const <FileEdit>[]) {
        edits[e.path] = e;
      }
    }
    filesChanged = edits.values.toList();
    return true;
  }

  void prependOlder(List<ChatItem> older, bool more) {
    final known = items.map((i) => i.seq).toSet();
    items = [...older.where((i) => !known.contains(i.seq)), ...items]
      ..sort((a, b) => a.seq.compareTo(b.seq));
    hasOlder = more;
  }
}

class PendingRequest {
  final String id;
  final String? chatId;
  final String command;
  final String detail;
  final String approveLabel;
  final String rejectLabel;
  const PendingRequest({
    required this.id,
    this.chatId,
    this.command = '',
    this.detail = '',
    this.approveLabel = 'Run',
    this.rejectLabel = 'Skip',
  });

  factory PendingRequest.fromJson(Map<String, dynamic> j) => PendingRequest(
        id: _str(j['id']),
        chatId: j['chatId'] == null ? null : _str(j['chatId']),
        command: _str(j['command']),
        detail: _str(j['detail']),
        approveLabel: _str(j['approveLabel']).isEmpty ? 'Run' : _str(j['approveLabel']),
        rejectLabel: _str(j['rejectLabel']).isEmpty ? 'Skip' : _str(j['rejectLabel']),
      );

  /// What the user is asked to approve, as shown in the card and the confirm dialog.
  String get shown => command.isNotEmpty ? command : (detail.isNotEmpty ? detail : 'Permission required');
}

class ComposerState {
  final String? chatId;
  final String title;
  final String model;
  final String mode;
  final String branch;
  final String environment;
  final int? contextPercent;
  final bool running;
  final PendingRequest? pending;
  final bool canModel;
  final bool canMode;
  final bool canStop;
  final bool canPrompt;
  const ComposerState({
    this.chatId,
    this.title = '',
    this.model = '',
    this.mode = 'Agent',
    this.branch = '',
    this.environment = '',
    this.contextPercent,
    this.running = false,
    this.pending,
    this.canModel = true,
    this.canMode = true,
    this.canStop = true,
    this.canPrompt = true,
  });

  factory ComposerState.fromJson(Map<String, dynamic> j) {
    final available = j['available'] is Map ? Map<String, dynamic>.from(j['available']) : const <String, dynamic>{};
    return ComposerState(
      chatId: j['chatId'] == null ? null : _str(j['chatId']),
      title: _str(j['title']),
      model: _str(j['model']),
      mode: _str(j['mode']).isEmpty ? 'Agent' : _str(j['mode']),
      branch: _str(j['branch']),
      environment: _str(j['environment']),
      contextPercent: j['contextPercent'] == null ? null : _int(j['contextPercent']),
      running: j['running'] == true,
      pending: j['pending'] is Map ? PendingRequest.fromJson(Map<String, dynamic>.from(j['pending'])) : null,
      canModel: available['model'] != false,
      canMode: available['mode'] != false,
      canStop: available['stop'] != false,
      canPrompt: available['prompt'] != false,
    );
  }
}

enum DiffLineKind { meta, hunk, context, added, removed }

class DiffLine {
  final DiffLineKind kind;
  final String text;
  final int? oldNo;
  final int? newNo;
  const DiffLine(this.kind, this.text, {this.oldNo, this.newNo});
}

class FileDiff {
  final String path;
  final String diff;
  final bool truncated;

  /// git | transcript
  final String source;
  FileDiff({required this.path, required this.diff, this.truncated = false, this.source = 'git'});

  factory FileDiff.fromJson(Map<String, dynamic> j) => FileDiff(
        path: _str(j['path']),
        diff: _str(j['diff']),
        truncated: j['truncated'] == true,
        source: _str(j['source']).isEmpty ? 'git' : _str(j['source']),
      );

  late final List<DiffLine> lines = parseUnifiedDiff(diff);
}

final _hunkHeader = RegExp(r'^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@');

List<DiffLine> parseUnifiedDiff(String diff) {
  final out = <DiffLine>[];
  var oldNo = 0;
  var newNo = 0;
  var inHunk = false;
  for (final line in diff.split('\n')) {
    final hunk = _hunkHeader.firstMatch(line);
    if (hunk != null) {
      oldNo = int.parse(hunk.group(1)!);
      newNo = int.parse(hunk.group(2)!);
      inHunk = true;
      out.add(DiffLine(DiffLineKind.hunk, line));
    } else if (!inHunk || line.startsWith('diff --git') || line.startsWith('+++ ') || line.startsWith('--- ')) {
      if (line.startsWith('diff --git')) inHunk = false;
      if (line.isNotEmpty) out.add(DiffLine(DiffLineKind.meta, line));
    } else if (line.startsWith('+')) {
      out.add(DiffLine(DiffLineKind.added, line.substring(1), newNo: newNo++));
    } else if (line.startsWith('-')) {
      out.add(DiffLine(DiffLineKind.removed, line.substring(1), oldNo: oldNo++));
    } else if (line.startsWith('\\')) {
      out.add(DiffLine(DiffLineKind.meta, line));
    } else {
      out.add(DiffLine(DiffLineKind.context, line.isEmpty ? '' : line.substring(1),
          oldNo: oldNo++, newNo: newNo++));
    }
  }
  while (out.isNotEmpty && out.last.kind == DiffLineKind.context && out.last.text.isEmpty) {
    out.removeLast();
  }
  return out;
}
