import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../models/connection_models.dart';
import '../theme/app_theme.dart';

/// Spacious first-run / reconnect landing — Local or Relay.
class ConnectionLandingPage extends StatelessWidget {
  final ConnectionType connectionType;
  final ValueChanged<ConnectionType> onTypeChanged;
  final TextEditingController hostController;
  final TextEditingController portController;
  final TextEditingController sessionIdController;
  final FocusNode? hostFocus;
  final FocusNode? sessionFocus;
  final bool connecting;
  final bool reconnecting;
  final bool waitingForPc;
  final String? pairingSessionId;
  final String? error;
  final List<ConnectionHistoryItem> recent;
  final VoidCallback onConnect;
  final VoidCallback? onCancelPairing;
  final VoidCallback? onCopySession;
  final VoidCallback? onShareSession;
  final VoidCallback? onRetry;
  final VoidCallback? onUseLocal;
  final void Function(ConnectionHistoryItem) onSelectRecent;
  final void Function(ConnectionHistoryItem)? onDeleteRecent;
  final VoidCallback? onClearRecent;
  final ValueChanged<String>? onHostChanged;
  final ValueChanged<String>? onPortChanged;

  const ConnectionLandingPage({
    super.key,
    required this.connectionType,
    required this.onTypeChanged,
    required this.hostController,
    required this.portController,
    required this.sessionIdController,
    required this.connecting,
    required this.reconnecting,
    required this.recent,
    required this.onConnect,
    required this.onSelectRecent,
    this.waitingForPc = false,
    this.pairingSessionId,
    this.hostFocus,
    this.sessionFocus,
    this.error,
    this.onCancelPairing,
    this.onCopySession,
    this.onShareSession,
    this.onRetry,
    this.onUseLocal,
    this.onDeleteRecent,
    this.onClearRecent,
    this.onHostChanged,
    this.onPortChanged,
  });

  bool get _busy => connecting || reconnecting;
  bool get _pairing =>
      waitingForPc &&
      pairingSessionId != null &&
      pairingSessionId!.trim().isNotEmpty;

  @override
  Widget build(BuildContext context) {
    final wide = MediaQuery.sizeOf(context).width >= 720;
    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [
            Color(0xFF0E1420),
            Color(0xFF0A0C10),
            Color(0xFF080A0E),
          ],
        ),
      ),
      child: SingleChildScrollView(
        padding: EdgeInsets.symmetric(
          horizontal: wide ? 32 : 22,
          vertical: wide ? 28 : 16,
        ),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 440),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SizedBox(height: wide ? 16 : 4),
                const _Hero(),
                const SizedBox(height: 32),
                _ModePicker(
                  value: connectionType,
                  enabled: !_busy && !_pairing,
                  onChanged: onTypeChanged,
                ),
                const SizedBox(height: 28),
                AnimatedSwitcher(
                  duration: const Duration(milliseconds: 240),
                  switchInCurve: Curves.easeOut,
                  switchOutCurve: Curves.easeIn,
                  child: connectionType == ConnectionType.local
                      ? _LocalBlock(
                          key: const ValueKey('local'),
                          hostController: hostController,
                          portController: portController,
                          hostFocus: hostFocus,
                          busy: _busy,
                          onConnect: onConnect,
                          onHostChanged: onHostChanged,
                          onPortChanged: onPortChanged,
                        )
                      : connectionType == ConnectionType.tunnel
                          ? _TunnelSetupPanel(
                              key: const ValueKey('tunnel'),
                              hostController: hostController,
                              hostFocus: hostFocus,
                              busy: _busy,
                              onConnect: onConnect,
                              onHostChanged: onHostChanged,
                            )
                          : (_pairing
                              ? _RelayPairingPanel(
                                  key: const ValueKey('pairing'),
                                  sessionId: pairingSessionId!,
                                  onCopy: onCopySession,
                                  onShare: onShareSession,
                                  onCancel: onCancelPairing,
                                )
                              : _RelaySetupPanel(
                                  key: const ValueKey('relay'),
                                  sessionIdController: sessionIdController,
                                  sessionFocus: sessionFocus,
                                  busy: _busy,
                                  onJoin: onConnect,
                                )),
                ),
                if (error != null &&
                    error!.isNotEmpty &&
                    !_pairing) ...[
                  const SizedBox(height: 16),
                  _ErrorBanner(message: error!),
                  const SizedBox(height: 8),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      if (onRetry != null)
                        TextButton(
                          onPressed: _busy ? null : onRetry,
                          child: const Text('Retry'),
                        ),
                      if (onUseLocal != null &&
                          connectionType == ConnectionType.relay) ...[
                        if (onRetry != null) const SizedBox(width: 8),
                        TextButton(
                          onPressed: _busy ? null : onUseLocal,
                          child: const Text('Use Local instead'),
                        ),
                      ],
                    ],
                  ),
                ],
                if (recent.isNotEmpty && !_pairing) ...[
                  const SizedBox(height: 36),
                  _RecentSection(
                    items: recent,
                    onSelect: onSelectRecent,
                    onDelete: onDeleteRecent,
                    onClear: onClearRecent,
                  ),
                ],
                const SizedBox(height: 24),
                Text(
                  connectionType == ConnectionType.local
                      ? 'Same Wi‑Fi as your Mac · default port 8766'
                      : connectionType == ConnectionType.tunnel
                          ? 'Any network · paste the wss:// URL from Cursor'
                          : 'Works from any network · Mac + phone both need internet',
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    color: Cr.textFaint,
                    fontSize: 12,
                    height: 1.45,
                  ),
                ),
                const SizedBox(height: 16),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Hero extends StatelessWidget {
  const _Hero();

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          width: 64,
          height: 64,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(18),
            gradient: const LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [Color(0xFF2A4A7A), Cr.accent],
            ),
            boxShadow: [
              BoxShadow(
                color: Cr.accent.withValues(alpha: 0.28),
                blurRadius: 24,
                offset: const Offset(0, 8),
              ),
            ],
          ),
          clipBehavior: Clip.antiAlias,
          child: Image.asset(
            'images/app_icon.png',
            fit: BoxFit.cover,
            errorBuilder: (_, __, ___) => const Icon(
              Icons.bolt_rounded,
              color: Colors.white,
              size: 32,
            ),
          ),
        ),
        const SizedBox(height: 18),
        const Text(
          'Cursor Remote',
          textAlign: TextAlign.center,
          style: TextStyle(
            color: Cr.text,
            fontSize: 28,
            fontWeight: FontWeight.w700,
            letterSpacing: -0.8,
            height: 1.1,
          ),
        ),
        const SizedBox(height: 10),
        const Text(
          'Connect once to your Mac.\nAgents and CLI open full screen next.',
          textAlign: TextAlign.center,
          style: TextStyle(
            color: Cr.textSecondary,
            fontSize: 14.5,
            height: 1.45,
            letterSpacing: -0.1,
          ),
        ),
      ],
    );
  }
}

class _ModePicker extends StatelessWidget {
  final ConnectionType value;
  final ValueChanged<ConnectionType> onChanged;
  final bool enabled;

  const _ModePicker({
    required this.value,
    required this.onChanged,
    required this.enabled,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Row(
          children: [
            Expanded(
              child: _ModeCard(
                selected: value == ConnectionType.local,
                icon: Icons.laptop_mac_rounded,
                title: 'Local',
                subtitle: 'Same Wi‑Fi',
                enabled: enabled,
                onTap: () => onChanged(ConnectionType.local),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _ModeCard(
                selected: value == ConnectionType.tunnel,
                icon: Icons.cloud_outlined,
                title: 'Tunnel',
                subtitle: 'Anywhere',
                enabled: enabled,
                onTap: () => onChanged(ConnectionType.tunnel),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        _ModeCard(
          selected: value == ConnectionType.relay,
          icon: Icons.public_rounded,
          title: 'Relay',
          subtitle: 'Session ID · needs unblocked relay host',
          enabled: enabled,
          onTap: () => onChanged(ConnectionType.relay),
          wide: true,
        ),
      ],
    );
  }
}

class _ModeCard extends StatelessWidget {
  final bool selected;
  final IconData icon;
  final String title;
  final String subtitle;
  final bool enabled;
  final VoidCallback onTap;
  final bool wide;

  const _ModeCard({
    required this.selected,
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.enabled,
    required this.onTap,
    this.wide = false,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? Cr.accentSoft : Cr.surface,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        onTap: enabled ? onTap : null,
        borderRadius: BorderRadius.circular(16),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          width: wide ? double.infinity : null,
          padding: EdgeInsets.fromLTRB(wide ? 16 : 14, 14, wide ? 16 : 14, 14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
              color: selected
                  ? Cr.accent.withValues(alpha: 0.55)
                  : Cr.borderSubtle,
              width: selected ? 1.5 : 1,
            ),
          ),
          child: wide
              ? Row(
                  children: [
                    Icon(icon,
                        size: 22,
                        color: selected ? Cr.accent : Cr.textSecondary),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            title,
                            style: TextStyle(
                              color: Cr.text,
                              fontSize: 15,
                              fontWeight:
                                  selected ? FontWeight.w700 : FontWeight.w600,
                              letterSpacing: -0.2,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            subtitle,
                            style: const TextStyle(
                                color: Cr.textFaint, fontSize: 12),
                          ),
                        ],
                      ),
                    ),
                  ],
                )
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(icon,
                        size: 22,
                        color: selected ? Cr.accent : Cr.textSecondary),
                    const SizedBox(height: 12),
                    Text(
                      title,
                      style: TextStyle(
                        color: Cr.text,
                        fontSize: 15,
                        fontWeight:
                            selected ? FontWeight.w700 : FontWeight.w600,
                        letterSpacing: -0.2,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      style:
                          const TextStyle(color: Cr.textFaint, fontSize: 12),
                    ),
                  ],
                ),
        ),
      ),
    );
  }
}

class _LocalBlock extends StatelessWidget {
  final TextEditingController hostController;
  final TextEditingController portController;
  final FocusNode? hostFocus;
  final bool busy;
  final VoidCallback onConnect;
  final ValueChanged<String>? onHostChanged;
  final ValueChanged<String>? onPortChanged;

  const _LocalBlock({
    super.key,
    required this.hostController,
    required this.portController,
    required this.busy,
    required this.onConnect,
    this.hostFocus,
    this.onHostChanged,
    this.onPortChanged,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const _FieldLabel('Mac address'),
        const SizedBox(height: 8),
        TextField(
          controller: hostController,
          focusNode: hostFocus,
          enabled: !busy,
          style: const TextStyle(color: Cr.text, fontSize: 15.5),
          decoration: _fieldDecoration(
            hint: '192.168.1.10',
            prefix: Icons.computer_rounded,
          ),
          keyboardType: TextInputType.url,
          autocorrect: false,
          enableSuggestions: false,
          textInputAction: TextInputAction.next,
          onChanged: onHostChanged,
          onSubmitted: (_) => onConnect(),
        ),
        const SizedBox(height: 16),
        const _FieldLabel('Port'),
        const SizedBox(height: 8),
        TextField(
          controller: portController,
          enabled: !busy,
          style: const TextStyle(color: Cr.text, fontSize: 15.5),
          decoration: _fieldDecoration(
            hint: '8766',
            prefix: Icons.tag_rounded,
          ),
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          textInputAction: TextInputAction.done,
          onChanged: onPortChanged,
          onSubmitted: (_) => onConnect(),
        ),
        const SizedBox(height: 24),
        SizedBox(
          height: 52,
          child: FilledButton(
            onPressed: busy ? null : onConnect,
            style: FilledButton.styleFrom(
              backgroundColor: Cr.accent,
              disabledBackgroundColor: Cr.surfaceHigh,
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(14),
              ),
            ),
            child: busy
                ? const SizedBox(
                    width: 22,
                    height: 22,
                    child: CircularProgressIndicator(
                      strokeWidth: 2.2,
                      color: Colors.white70,
                    ),
                  )
                : const Text(
                    'Connect',
                    style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                      letterSpacing: -0.2,
                    ),
                  ),
          ),
        ),
      ],
    );
  }
}

/// Cloudflare / public wss tunnel — paste URL from Cursor.
class _TunnelSetupPanel extends StatelessWidget {
  final TextEditingController hostController;
  final FocusNode? hostFocus;
  final bool busy;
  final VoidCallback onConnect;
  final ValueChanged<String>? onHostChanged;

  const _TunnelSetupPanel({
    super.key,
    required this.hostController,
    required this.busy,
    required this.onConnect,
    this.hostFocus,
    this.onHostChanged,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: Cr.accentSoft,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: Cr.accent.withValues(alpha: 0.28)),
          ),
          child: const Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Cloudflare Tunnel',
                style: TextStyle(
                  color: Cr.text,
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                  letterSpacing: -0.2,
                ),
              ),
              SizedBox(height: 6),
              Text(
                '1. On Mac: Cmd+Shift+P → “Cursor Remote: Start Cloudflare Tunnel”\n'
                '2. Paste the copied wss:// URL in the box below\n'
                '3. Tap Connect — works from any network',
                style: TextStyle(
                  color: Cr.textSecondary,
                  fontSize: 13,
                  height: 1.45,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 20),
        const _FieldLabel('Tunnel URL'),
        const SizedBox(height: 8),
        TextField(
          controller: hostController,
          focusNode: hostFocus,
          enabled: !busy,
          style: const TextStyle(color: Cr.text, fontSize: 14.5),
          decoration: _fieldDecoration(
            hint: 'wss://….trycloudflare.com',
            prefix: Icons.link_rounded,
          ),
          keyboardType: TextInputType.url,
          autocorrect: false,
          enableSuggestions: false,
          textInputAction: TextInputAction.done,
          onChanged: onHostChanged,
          onSubmitted: (_) => onConnect(),
        ),
        const SizedBox(height: 10),
        const Text(
          'https:// links are converted to wss:// automatically.',
          style: TextStyle(color: Cr.textFaint, fontSize: 12, height: 1.4),
        ),
        const SizedBox(height: 24),
        ListenableBuilder(
          listenable: hostController,
          builder: (context, _) {
            final hasUrl = hostController.text.trim().isNotEmpty;
            return SizedBox(
              height: 52,
              child: FilledButton.icon(
                onPressed: busy || !hasUrl ? null : onConnect,
                icon: busy
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.white70,
                        ),
                      )
                    : const Icon(Icons.cloud_done_rounded, size: 20),
                label: Text(
                  busy
                      ? 'Connecting…'
                      : (hasUrl
                          ? 'Connect via Tunnel'
                          : 'Paste tunnel URL first'),
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                    letterSpacing: -0.2,
                  ),
                ),
                style: FilledButton.styleFrom(
                  backgroundColor: Cr.accent,
                  disabledBackgroundColor: Cr.surfaceHigh,
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14),
                  ),
                ),
              ),
            );
          },
        ),
      ],
    );
  }
}

/// Idle Relay: join a session created in Cursor.
class _RelaySetupPanel extends StatelessWidget {
  final TextEditingController sessionIdController;
  final FocusNode? sessionFocus;
  final bool busy;
  final VoidCallback onJoin;

  const _RelaySetupPanel({
    super.key,
    required this.sessionIdController,
    required this.busy,
    required this.onJoin,
    this.sessionFocus,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: Cr.accentSoft,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: Cr.accent.withValues(alpha: 0.28)),
          ),
          child: const Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Control Cursor from any network',
                style: TextStyle(
                  color: Cr.text,
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                  letterSpacing: -0.2,
                ),
              ),
              SizedBox(height: 6),
              Text(
                '1. In Cursor: connect to Relay to create the session\n'
                '2. Run “Cursor Remote: Pair Relay Client”\n'
                '3. Enter the Session ID below, then paste the pairing code',
                style: TextStyle(
                  color: Cr.textSecondary,
                  fontSize: 13,
                  height: 1.45,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 20),
        const _FieldLabel('Session ID'),
        const SizedBox(height: 8),
        TextField(
          controller: sessionIdController,
          focusNode: sessionFocus,
          enabled: !busy,
          style: const TextStyle(
            color: Cr.text,
            fontSize: 18,
            fontWeight: FontWeight.w600,
            letterSpacing: 3,
          ),
          textAlign: TextAlign.center,
          textCapitalization: TextCapitalization.characters,
          inputFormatters: [
            FilteringTextInputFormatter.allow(RegExp(r'[A-Za-z0-9]')),
            _UpperCaseTextFormatter(),
          ],
          decoration: _fieldDecoration(
            hint: 'ABC123',
            prefix: Icons.key_rounded,
          ).copyWith(
            prefixIcon: null,
            contentPadding:
                const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
            hintStyle: const TextStyle(
              color: Cr.textFaint,
              fontSize: 15,
              fontWeight: FontWeight.w400,
              letterSpacing: 2,
            ),
          ),
          textInputAction: TextInputAction.done,
          onSubmitted: (_) => onJoin(),
        ),
        const SizedBox(height: 12),
        SizedBox(
          height: 48,
          child: OutlinedButton(
            onPressed: busy ? null : onJoin,
            style: OutlinedButton.styleFrom(
              foregroundColor: Cr.text,
              side: const BorderSide(color: Cr.border),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(14),
              ),
            ),
            child: const Text(
              'Connect with Session ID',
              style: TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
        ),
      ],
    );
  }
}

/// Active pairing: Session ID + QR + steps + waiting for Mac.
class _RelayPairingPanel extends StatefulWidget {
  final String sessionId;
  final VoidCallback? onCopy;
  final VoidCallback? onShare;
  final VoidCallback? onCancel;

  const _RelayPairingPanel({
    super.key,
    required this.sessionId,
    this.onCopy,
    this.onShare,
    this.onCancel,
  });

  @override
  State<_RelayPairingPanel> createState() => _RelayPairingPanelState();
}

class _RelayPairingPanelState extends State<_RelayPairingPanel>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulse;

  @override
  void initState() {
    super.initState();
    _pulse = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final id = widget.sessionId.trim().toUpperCase();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        FadeTransition(
          opacity: Tween(begin: 0.55, end: 1.0).animate(_pulse),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              color: Cr.warning.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: Cr.warning.withValues(alpha: 0.35)),
            ),
            child: const Row(
              children: [
                SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: Cr.warning,
                  ),
                ),
                SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'Waiting for Cursor on your Mac…',
                    style: TextStyle(
                      color: Cr.text,
                      fontSize: 13.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 20),
        Container(
          padding: const EdgeInsets.fromLTRB(16, 20, 16, 20),
          decoration: BoxDecoration(
            color: Cr.surface,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: Cr.border),
          ),
          child: Column(
            children: [
              const Text(
                'SESSION ID',
                style: TextStyle(
                  color: Cr.textFaint,
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 1.2,
                ),
              ),
              const SizedBox(height: 10),
              SelectableText(
                id,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  color: Cr.accent,
                  fontSize: 36,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 6,
                  height: 1.1,
                ),
              ),
            // QR omitted (no qr_flutter dependency)
              const SizedBox(height: 8),
              const Text(
                'Type this ID in Cursor',
                style: TextStyle(color: Cr.textFaint, fontSize: 12),
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: widget.onCopy,
                      icon: const Icon(Icons.copy_rounded, size: 18),
                      label: const Text('Copy'),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: Cr.text,
                        side: const BorderSide(color: Cr.border),
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: FilledButton.tonalIcon(
                      onPressed: widget.onShare,
                      icon: const Icon(Icons.ios_share_rounded, size: 18),
                      label: const Text('Share'),
                      style: FilledButton.styleFrom(
                        backgroundColor: Cr.accentSoft,
                        foregroundColor: Cr.accent,
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 20),
        const _PairingSteps(),
        const SizedBox(height: 16),
        TextButton(
          onPressed: widget.onCancel,
          style: TextButton.styleFrom(foregroundColor: Cr.textFaint),
          child: const Text('Cancel pairing'),
        ),
      ],
    );
  }
}

class _PairingSteps extends StatelessWidget {
  const _PairingSteps();

  @override
  Widget build(BuildContext context) {
    const steps = [
      (Icons.check_circle_rounded, Cr.success, 'Session created on this phone'),
      (
        Icons.looks_two_rounded,
        Cr.accent,
        'On Mac: Cmd+Shift+P → “Connect to Relay by Session ID”'
      ),
      (Icons.looks_3_rounded, Cr.textSecondary, 'Paste the Session ID (PIN optional)'),
      (Icons.looks_4_rounded, Cr.textSecondary, 'This app connects automatically'),
    ];
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Cr.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Cr.borderSubtle),
      ),
      child: Column(
        children: [
          for (var i = 0; i < steps.length; i++) ...[
            if (i > 0) const SizedBox(height: 10),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(steps[i].$1, size: 18, color: steps[i].$2),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    steps[i].$3,
                    style: TextStyle(
                      color: i == 0 ? Cr.text : Cr.textSecondary,
                      fontSize: 13,
                      height: 1.35,
                      fontWeight: i == 0 ? FontWeight.w600 : FontWeight.w400,
                    ),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _FieldLabel extends StatelessWidget {
  final String text;
  const _FieldLabel(this.text);

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: const TextStyle(
        color: Cr.textSecondary,
        fontSize: 12,
        fontWeight: FontWeight.w600,
        letterSpacing: 0.25,
      ),
    );
  }
}

InputDecoration _fieldDecoration({
  required String hint,
  required IconData prefix,
}) {
  return InputDecoration(
    hintText: hint,
    hintStyle: const TextStyle(color: Cr.textFaint, letterSpacing: 0),
    filled: true,
    fillColor: Cr.surface,
    prefixIcon: Icon(prefix, color: Cr.textFaint, size: 20),
    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
    border: OutlineInputBorder(
      borderRadius: BorderRadius.circular(14),
      borderSide: const BorderSide(color: Cr.borderSubtle),
    ),
    enabledBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(14),
      borderSide: const BorderSide(color: Cr.borderSubtle),
    ),
    focusedBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(14),
      borderSide: const BorderSide(color: Cr.accent, width: 1.4),
    ),
    disabledBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(14),
      borderSide: const BorderSide(color: Cr.borderSubtle),
    ),
  );
}

class _ErrorBanner extends StatelessWidget {
  final String message;
  const _ErrorBanner({required this.message});

  @override
  Widget build(BuildContext context) {
    final short = message.length > 160
        ? '${message.substring(0, 160).trimRight()}…'
        : message;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Cr.danger.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Cr.danger.withValues(alpha: 0.35)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.error_outline_rounded, color: Cr.danger, size: 18),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              short,
              style: const TextStyle(color: Cr.text, fontSize: 13, height: 1.4),
            ),
          ),
        ],
      ),
    );
  }
}

class _RecentSection extends StatelessWidget {
  final List<ConnectionHistoryItem> items;
  final void Function(ConnectionHistoryItem) onSelect;
  final void Function(ConnectionHistoryItem)? onDelete;
  final VoidCallback? onClear;

  const _RecentSection({
    required this.items,
    required this.onSelect,
    this.onDelete,
    this.onClear,
  });

  @override
  Widget build(BuildContext context) {
    final shown = items.take(4).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            const Expanded(
              child: Text(
                'RECENT',
                style: TextStyle(
                  color: Cr.textFaint,
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.8,
                ),
              ),
            ),
            if (onClear != null)
              TextButton(
                onPressed: onClear,
                style: TextButton.styleFrom(
                  foregroundColor: Cr.textFaint,
                  visualDensity: VisualDensity.compact,
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                ),
                child: const Text('Clear'),
              ),
          ],
        ),
        const SizedBox(height: 6),
        ...shown.map((item) {
          return Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Material(
              color: Cr.surface,
              borderRadius: BorderRadius.circular(12),
              child: InkWell(
                onTap: () => onSelect(item),
                borderRadius: BorderRadius.circular(12),
                child: Padding(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  child: Row(
                    children: [
                      Icon(
                        item.type == ConnectionType.local
                            ? Icons.laptop_mac_rounded
                            : item.type == ConnectionType.tunnel
                                ? Icons.cloud_outlined
                                : Icons.public_rounded,
                        size: 18,
                        color: Cr.textSecondary,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              item.displayText,
                              style: const TextStyle(
                                color: Cr.text,
                                fontSize: 13.5,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              item.relativeTime,
                              style: const TextStyle(
                                color: Cr.textFaint,
                                fontSize: 11.5,
                              ),
                            ),
                          ],
                        ),
                      ),
                      if (onDelete != null)
                        IconButton(
                          onPressed: () => onDelete!(item),
                          icon: const Icon(Icons.close_rounded,
                              size: 16, color: Cr.textFaint),
                          visualDensity: VisualDensity.compact,
                          tooltip: 'Remove',
                        ),
                    ],
                  ),
                ),
              ),
            ),
          );
        }),
      ],
    );
  }
}

class _UpperCaseTextFormatter extends TextInputFormatter {
  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    return TextEditingValue(
      text: newValue.text.toUpperCase(),
      selection: newValue.selection,
    );
  }
}
