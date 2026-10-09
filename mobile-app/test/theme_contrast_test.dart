import 'dart:math' as math;
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';

import 'package:cursor_remote/theme/app_theme.dart';

/// WCAG 2.x relative luminance, from the 8-bit sRGB channels.
double luminance(Color c) {
  double channel(double v) => v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

double contrast(Color a, Color b) {
  final la = luminance(a);
  final lb = luminance(b);
  return (math.max(la, lb) + 0.05) / (math.min(la, lb) + 0.05);
}

void main() {
  test('the WCAG formula matches known values', () {
    expect(contrast(const Color(0xFF000000), const Color(0xFFFFFFFF)), closeTo(21, 0.001));
    expect(contrast(const Color(0xFF777777), const Color(0xFFFFFFFF)), closeTo(4.48, 0.01));
  });

  test('secondary and faint text reach WCAG AA (4.5:1) on the background and on surfaces', () {
    for (final (name, fg) in [('textFaint', Cr.textFaint), ('textSecondary', Cr.textSecondary)]) {
      for (final (bgName, bg) in [('bg', Cr.bg), ('surface', Cr.surface)]) {
        expect(contrast(fg, bg), greaterThanOrEqualTo(4.5), reason: '$name on $bgName');
      }
    }
  });
}
