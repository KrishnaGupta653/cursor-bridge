import 'dart:js_interop';

@JS('crLaunchPairingCode')
external JSString? get _launchCode;

@JS('crLaunchPairingCode')
external set _launchCode(JSString? value);

/// The single-use code web/index.html took from a one-tap pairing link; readable once.
String? takeLaunchPairingCode() {
  final code = _launchCode?.toDart;
  _launchCode = null;
  return code;
}
