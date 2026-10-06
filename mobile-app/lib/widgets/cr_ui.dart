import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

/// Compact live status chip used in app bars and sidebars.
class CrStatusChip extends StatelessWidget {
  final bool ok;
  final bool busy;
  final String label;

  const CrStatusChip({
    super.key,
    required this.ok,
    required this.label,
    this.busy = false,
  });

  @override
  Widget build(BuildContext context) {
    final color = busy
        ? Cr.warning
        : ok
            ? Cr.success
            : Cr.textFaint;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (busy)
            SizedBox(
              width: 10,
              height: 10,
              child: CircularProgressIndicator(
                strokeWidth: 1.5,
                color: color,
              ),
            )
          else
            Container(
              width: 7,
              height: 7,
              decoration: BoxDecoration(color: color, shape: BoxShape.circle),
            ),
          const SizedBox(width: 7),
          Text(
            label,
            style: TextStyle(
              color: color,
              fontSize: 11,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.2,
            ),
          ),
        ],
      ),
    );
  }
}

/// Primary mode switch: CLI Agent vs Existing Agent (Agents).
class CrModeSwitch extends StatelessWidget {
  final String value; // cli | cdp
  final ValueChanged<String> onChanged;
  final bool compact;

  const CrModeSwitch({
    super.key,
    required this.value,
    required this.onChanged,
    this.compact = false,
  });

  @override
  Widget build(BuildContext context) {
    Widget pill(String id, String label, IconData icon) {
      final selected = value == id;
      return Material(
        color: selected ? Cr.accentSoft : Colors.transparent,
        borderRadius: BorderRadius.circular(Cr.radiusSm),
        child: InkWell(
          borderRadius: BorderRadius.circular(Cr.radiusSm),
          onTap: () => onChanged(id),
          child: Padding(
            padding: EdgeInsets.symmetric(
              horizontal: compact ? 10 : 12,
              vertical: compact ? 7 : 8,
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(icon,
                    size: 14,
                    color: selected ? Cr.accent : Cr.textFaint),
                if (!compact) ...[
                  const SizedBox(width: 6),
                  Text(
                    label,
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                      color: selected ? Cr.text : Cr.textSecondary,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: Cr.surfaceHigh,
        borderRadius: BorderRadius.circular(Cr.radiusMd),
        border: Border.all(color: Cr.borderSubtle),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          pill('cdp', 'Agents', Icons.auto_awesome_rounded),
          pill('cli', 'CLI', Icons.terminal_rounded),
        ],
      ),
    );
  }
}

/// Brand mark for app bars.
class CrBrandMark extends StatelessWidget {
  final bool showTitle;
  const CrBrandMark({super.key, this.showTitle = true});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 30,
          height: 30,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(8),
            gradient: const LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [Color(0xFF2A4A7A), Cr.accent],
            ),
            boxShadow: [
              BoxShadow(
                color: Cr.accent.withValues(alpha: 0.25),
                blurRadius: 10,
                offset: const Offset(0, 2),
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
              size: 18,
            ),
          ),
        ),
        if (showTitle) ...[
          const SizedBox(width: 10),
          const Flexible(
            child: Text(
              'Cursor Remote',
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontWeight: FontWeight.w700,
                fontSize: 16,
                letterSpacing: -0.4,
                color: Cr.text,
              ),
            ),
          ),
        ],
      ],
    );
  }
}

/// Soft panel wrapper used across Home / Settings.
class CrPanel extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry? padding;
  final EdgeInsetsGeometry? margin;

  const CrPanel({
    super.key,
    required this.child,
    this.padding,
    this.margin,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: margin ?? const EdgeInsets.all(12),
      padding: padding,
      decoration: BoxDecoration(
        color: Cr.surface,
        borderRadius: BorderRadius.circular(Cr.radiusLg),
        border: Border.all(color: Cr.borderSubtle),
      ),
      child: child,
    );
  }
}

/// Section eyebrow label.
class CrSectionLabel extends StatelessWidget {
  final String text;
  const CrSectionLabel(this.text, {super.key});

  @override
  Widget build(BuildContext context) {
    return Text(
      text.toUpperCase(),
      style: const TextStyle(
        color: Cr.textFaint,
        fontSize: 10,
        fontWeight: FontWeight.w700,
        letterSpacing: 0.9,
      ),
    );
  }
}
