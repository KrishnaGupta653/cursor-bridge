/// Browser notifications only exist on web.
bool get notificationsSupported => false;

/// 'granted', 'denied' or 'default'.
String get notificationPermission => 'denied';

Future<bool> requestNotifications() async => false;

bool get pageHidden => false;

void showNotification(String title, String body, {required String tag, void Function()? onTap}) {}
