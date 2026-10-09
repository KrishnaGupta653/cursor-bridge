import 'package:flutter/material.dart';

/// Cursor Remote design system — product shell + Agents/IDE-aligned surfaces.
///
/// Dark-first product identity (zinc/charcoal + blue accent). Agent chat
/// surfaces use the same tokens so CLI ↔ Existing Agent never clash.
class Cr {
  Cr._();

  // Canvas
  static const bg = Color(0xFF0A0C10);
  static const bgElevated = Color(0xFF0F1218);
  static const surface = Color(0xFF141820);
  static const surfaceHigh = Color(0xFF1A1F2A);
  static const surfaceHover = Color(0xFF222833);

  // Borders
  static const border = Color(0xFF2A3140);
  static const borderSubtle = Color(0xFF1E2430);

  // Text
  static const text = Color(0xFFE8EAED);
  static const textSecondary = Color(0xFF9AA3B2);
  static const textFaint = Color(0xFF798193);

  // Accent (blue — not purple)
  static const accent = Color(0xFF5B8DEF);
  static const accentSoft = Color(0xFF1A2740);
  static const accentMuted = Color(0xFF3D6BC4);

  // Status
  static const success = Color(0xFF3DDC97);
  static const warning = Color(0xFFF0B429);
  static const danger = Color(0xFFFF6B6B);
  static const info = Color(0xFF5B8DEF);

  // Chat (Cursor Agents–aligned)
  static const userBubble = Color(0xFF2A2F3A);
  static const link = Color(0xFF6BA4F8);

  static const radiusSm = 8.0;
  static const radiusMd = 12.0;
  static const radiusLg = 16.0;
  static const radiusXl = 20.0;

  /// Minimum tap area for icon buttons. Pair with `VisualDensity.standard`, since desktop density shrinks it.
  static const tapTarget = BoxConstraints(minWidth: 44, minHeight: 44);

  static const sidebarWidth = 300.0;
  static const wideBreakpoint = 900.0;
  static const tabletBreakpoint = 700.0;
}

ThemeData buildCrDarkTheme() {
  const scheme = ColorScheme.dark(
    primary: Cr.accent,
    onPrimary: Colors.white,
    primaryContainer: Cr.accentSoft,
    onPrimaryContainer: Cr.text,
    secondary: Cr.textSecondary,
    onSecondary: Cr.bg,
    secondaryContainer: Cr.surfaceHigh,
    onSecondaryContainer: Cr.text,
    tertiary: Cr.success,
    onTertiary: Cr.bg,
    error: Cr.danger,
    onError: Colors.white,
    surface: Cr.surface,
    onSurface: Cr.text,
    surfaceContainerHighest: Cr.surfaceHigh,
    onSurfaceVariant: Cr.textSecondary,
    outline: Cr.border,
    outlineVariant: Cr.borderSubtle,
  );

  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    colorScheme: scheme,
    scaffoldBackgroundColor: Cr.bg,
    canvasColor: Cr.bg,
    dividerColor: Cr.borderSubtle,
    appBarTheme: const AppBarTheme(
      backgroundColor: Cr.bgElevated,
      foregroundColor: Cr.text,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(
        color: Cr.text,
        fontSize: 16,
        fontWeight: FontWeight.w600,
        letterSpacing: -0.3,
      ),
    ),
    cardTheme: CardThemeData(
      color: Cr.surface,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Cr.radiusMd),
        side: const BorderSide(color: Cr.borderSubtle),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Cr.surfaceHigh,
      hintStyle: const TextStyle(color: Cr.textFaint),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Cr.radiusMd),
        borderSide: BorderSide.none,
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Cr.radiusMd),
        borderSide: const BorderSide(color: Cr.borderSubtle),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Cr.radiusMd),
        borderSide: const BorderSide(color: Cr.accent, width: 1.2),
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        elevation: 0,
        backgroundColor: Cr.accent,
        foregroundColor: Colors.white,
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Cr.radiusMd),
        ),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        elevation: 0,
        backgroundColor: Cr.accent,
        foregroundColor: Colors.white,
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Cr.radiusMd),
        ),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: Cr.text,
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
        side: const BorderSide(color: Cr.border),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Cr.radiusMd),
        ),
      ),
    ),
    segmentedButtonTheme: SegmentedButtonThemeData(
      style: ButtonStyle(
        backgroundColor: WidgetStateProperty.resolveWith((s) {
          if (s.contains(WidgetState.selected)) return Cr.accentSoft;
          return Cr.surfaceHigh;
        }),
        foregroundColor: WidgetStateProperty.resolveWith((s) {
          if (s.contains(WidgetState.selected)) return Cr.accent;
          return Cr.textSecondary;
        }),
        side: WidgetStateProperty.all(const BorderSide(color: Cr.border)),
        visualDensity: VisualDensity.compact,
      ),
    ),
    chipTheme: ChipThemeData(
      backgroundColor: Cr.surfaceHigh,
      selectedColor: Cr.accentSoft,
      labelStyle: const TextStyle(color: Cr.textSecondary, fontSize: 12),
      side: const BorderSide(color: Cr.borderSubtle),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Cr.radiusSm),
      ),
    ),
    tabBarTheme: const TabBarThemeData(
      indicatorColor: Cr.accent,
      labelColor: Cr.text,
      unselectedLabelColor: Cr.textFaint,
      dividerColor: Cr.borderSubtle,
      indicatorSize: TabBarIndicatorSize.label,
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: Cr.surfaceHigh,
      contentTextStyle: const TextStyle(color: Cr.text),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Cr.radiusMd),
      ),
    ),
    listTileTheme: const ListTileThemeData(
      iconColor: Cr.textSecondary,
      textColor: Cr.text,
    ),
    expansionTileTheme: const ExpansionTileThemeData(
      backgroundColor: Cr.surface,
      collapsedBackgroundColor: Cr.surface,
      iconColor: Cr.textSecondary,
      collapsedIconColor: Cr.textFaint,
      textColor: Cr.text,
      collapsedTextColor: Cr.text,
      shape: RoundedRectangleBorder(),
      collapsedShape: RoundedRectangleBorder(),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: Cr.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Cr.radiusLg),
      ),
    ),
  );
}
