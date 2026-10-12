import 'dart:js_interop';
import 'dart:js_interop_unsafe';

/// iOS Safari only has notifications for a site added to the Home Screen.
bool get notificationsSupported => globalContext.has('Notification');

JSFunction get _notification => globalContext['Notification'] as JSFunction;

/// 'granted', 'denied' or 'default'.
String get notificationPermission =>
    notificationsSupported ? (_notification['permission'] as JSString).toDart : 'denied';

Future<bool> requestNotifications() async {
  if (!notificationsSupported) return false;
  if (notificationPermission == 'granted') return true;
  final result = await _notification.callMethod<JSPromise<JSString>>('requestPermission'.toJS).toDart;
  return result.toDart == 'granted';
}

bool get pageHidden => ((globalContext['document'] as JSObject)['hidden'] as JSBoolean).toDart;

/// One notification per [tag]: a newer one for the same chat replaces it.
void showNotification(String title, String body, {required String tag, void Function()? onTap}) {
  if (notificationPermission != 'granted') return;
  final options = JSObject()
    ..['body'] = body.toJS
    ..['tag'] = tag.toJS
    ..['icon'] = 'icons/Icon-192.png'.toJS;
  final n = _notification.callAsConstructor<JSObject>(title.toJS, options);
  n['onclick'] = (() {
    globalContext.callMethod('focus'.toJS);
    n.callMethod('close'.toJS);
    onTap?.call();
  }).toJS;
}
