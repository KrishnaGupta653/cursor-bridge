import 'package:flutter/material.dart';
import '../models/cdp_models.dart';

/// Compact panel for Existing Cursor Agent (CDP) mode.
class CdpSessionPanel extends StatelessWidget {
  final bool cdpEnabledHint;
  final bool cdpConnected;
  final String? cdpError;
  final List<CdpSessionInfo> sessions;
  final String? selectedSessionId;
  final String agentState;
  final List<CdpAgentMessage> messages;
  final CdpAgentPlan? plan;
  final CdpPermissionRequest? pendingApproval;
  final ValueChanged<String> onSelectSession;
  final VoidCallback onRefresh;
  final VoidCallback? onApprove;
  final VoidCallback? onReject;

  const CdpSessionPanel({
    super.key,
    required this.cdpEnabledHint,
    required this.cdpConnected,
    required this.cdpError,
    required this.sessions,
    required this.selectedSessionId,
    required this.agentState,
    required this.messages,
    required this.plan,
    required this.pendingApproval,
    required this.onSelectSession,
    required this.onRefresh,
    this.onApprove,
    this.onReject,
  });

  Color _stateColor(BuildContext context) {
    switch (colorHintForAgentState(agentState)) {
      case ColorForState.green:
        return Colors.green;
      case ColorForState.yellow:
        return Colors.amber.shade700;
      case ColorForState.red:
        return Colors.red;
      case ColorForState.grey:
        return Theme.of(context).colorScheme.onSurfaceVariant;
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.5),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: scheme.outline.withValues(alpha: 0.2)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.desktop_windows, size: 18, color: scheme.primary),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'CURSOR SESSIONS',
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: scheme.onSurface,
                  ),
                ),
              ),
              IconButton(
                tooltip: 'Refresh sessions',
                onPressed: onRefresh,
                icon: const Icon(Icons.refresh, size: 18),
                visualDensity: VisualDensity.compact,
              ),
            ],
          ),
          Text(
            cdpConnected
                ? 'CDP connected'
                : (cdpError ?? 'CDP not connected — enable CDP & launch Cursor with --remote-debugging-port=9222'),
            style: TextStyle(
              fontSize: 11,
              color: cdpConnected ? Colors.green.shade700 : scheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 8),
          if (sessions.isEmpty)
            Text(
              'No Cursor windows discovered yet.',
              style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
            )
          else
            ...sessions.map((s) {
              final selected = s.id == selectedSessionId;
              final hint = colorHintForAgentState(s.state);
              final dot = hint == ColorForState.green
                  ? '🟢'
                  : hint == ColorForState.yellow
                      ? '🟡'
                      : '⚪';
              return InkWell(
                onTap: () => onSelectSession(s.id),
                borderRadius: BorderRadius.circular(8),
                child: Container(
                  width: double.infinity,
                  margin: const EdgeInsets.only(bottom: 6),
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  decoration: BoxDecoration(
                    color: selected
                        ? scheme.primaryContainer.withValues(alpha: 0.45)
                        : scheme.surface,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: selected
                          ? scheme.primary.withValues(alpha: 0.5)
                          : scheme.outline.withValues(alpha: 0.15),
                    ),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '$dot ${s.title}',
                        style: const TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      Text(
                        'Agent: ${s.state}',
                        style: TextStyle(
                          fontSize: 11,
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              );
            }),
          if (selectedSessionId != null) ...[
            const Divider(height: 16),
            Row(
              children: [
                Text(
                  'Cursor Agent',
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: scheme.onSurface,
                  ),
                ),
                const SizedBox(width: 8),
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: _stateColor(context),
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 6),
                Text(
                  agentState,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: _stateColor(context),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 180),
              child: messages.isEmpty
                  ? Text(
                      'Conversation not available yet (DOM extraction may be limited).',
                      style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
                    )
                  : ListView.builder(
                      shrinkWrap: true,
                      itemCount: messages.length,
                      itemBuilder: (context, index) {
                        final m = messages[index];
                        final isUser = m.role == 'user';
                        return Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                isUser ? 'User' : 'Agent',
                                style: TextStyle(
                                  fontSize: 11,
                                  fontWeight: FontWeight.w700,
                                  color: isUser
                                      ? scheme.primary
                                      : scheme.tertiary,
                                ),
                              ),
                              Text(
                                m.text,
                                style: const TextStyle(fontSize: 12),
                                maxLines: 8,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ],
                          ),
                        );
                      },
                    ),
            ),
            if (plan != null && plan!.available) ...[
              const SizedBox(height: 8),
              Text(
                'Plan${plan!.title.isNotEmpty ? ': ${plan!.title}' : ''}',
                style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
              ),
              ...plan!.steps.take(8).map(
                    (step) => Text(
                      '• [${step.status}] ${step.text}',
                      style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
            ],
            if (pendingApproval != null) ...[
              const SizedBox(height: 10),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.amber.shade50,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: Colors.amber.shade700),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      pendingApproval!.title,
                      style: const TextStyle(
                        fontWeight: FontWeight.w700,
                        fontSize: 13,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Agent wants to:\n${pendingApproval!.detail}',
                      style: const TextStyle(fontSize: 12),
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        OutlinedButton(
                          onPressed: onReject,
                          child: const Text('Reject'),
                        ),
                        const SizedBox(width: 12),
                        FilledButton(
                          onPressed: onApprove,
                          child: const Text('Approve'),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ],
        ],
      ),
    );
  }
}
