// Service worker: shows push notifications even when the app/browser is closed
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'Notification', body: e.data ? e.data.text() : '' }; }
  const opts = { body: d.body || '', data: { url: d.url || '/' }, tag: d.tag || undefined };
  if (d.icon) { opts.icon = d.icon; opts.badge = d.icon; }
  if (d.image) opts.image = d.image;
  e.waitUntil(self.registration.showNotification(d.title || 'Notification', opts));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow(url);
  }));
});
