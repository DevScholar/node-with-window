import { imports as gjsImports } from '@devscholar/node-with-gjs';

// There can only be one Gtk.Application per process.  All BrowserWindows share
// the same application instance and the same GJS IPC connection.

export let _gi: any = null;
export let _Gtk: any = null;
export let _Gdk: any = null;
export let _WebKit: any = null;  // either WebKit 6.0 or WebKit2 4.1
export let _Gio: any = null;
export let _gtkApp: any = null;
export let _appRunning = false;
/** Callbacks queued before activate fires; drained in the activate handler. */
export const _pendingWindowCreations: Array<() => void> = [];

export function ensureGiLoaded(): void {
  if (_gi) return;
  _gi = gjsImports.gi;
  _gi.versions.Gtk = '4.0';
  _gi.versions.Gdk = '4.0';
  _Gtk = _gi.Gtk;
  _Gdk = _gi.Gdk;
  _Gio = _gi.Gio;

  // Prefer WebKit 6.0 (newer), fall back to WebKit2 4.1 (GTK4 API)
  try {
    _gi.versions.WebKit = '6.0';
    _WebKit = _gi.WebKit;
  } catch {
    try {
      _gi.versions.WebKit2 = '4.1';
      _WebKit = _gi.WebKit2;
    } catch (e) {
      console.error('[gjs-gtk4] Could not load WebKit namespace:', e);
      _WebKit = null;
    }
  }
}

export function ensureGtkApp(): void {
  if (_gtkApp) return;
  ensureGiLoaded();
  _gtkApp = new _Gtk.Application({ application_id: 'org.nodejs.nww' });
  // MUST be a sync (non-async) callback: GJS blocks in processNestedCommands()
  // while Node.js creates windows inline.  If async, app.run() sees zero
  // windows after activate returns and quits immediately, killing the host.
  _gtkApp.connect('activate', () => {
    _appRunning = true;
    const callbacks = _pendingWindowCreations.splice(0);
    for (const fn of callbacks) fn();
  });
}
