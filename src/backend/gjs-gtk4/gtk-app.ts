import { imports as gjsImports } from '@devscholar/node-with-gjs';
import type Gtk from '@girs/gtk-4.0';
import type Gdk from '@girs/gdk-4.0';
import type Gio from '@girs/gio-2.0';
import type GLib from '@girs/glib-2.0';
import type WebKit from '@girs/webkit-6.0';

export let _gi: typeof gjsImports.gi = null as unknown as typeof gjsImports.gi;
export let _Gtk: typeof Gtk = null as unknown as typeof Gtk;
export let _Gdk: typeof Gdk = null as unknown as typeof Gdk;
export let _GLib: typeof GLib = null as unknown as typeof GLib;
export let _WebKit: typeof WebKit = null as unknown as typeof WebKit;
export let _Gio: typeof Gio = null as unknown as typeof Gio;
export let _gtkApp: Gtk.Application = null as unknown as Gtk.Application;
export let _appRunning = false;
export const _pendingWindowCreations: Array<() => void> = [];

export function ensureGiLoaded(): void {
  if (_gi) return;
  _gi = gjsImports.gi;
  _gi.versions.Gtk = '4.0';
  _gi.versions.Gdk = '4.0';
  _Gtk = _gi.Gtk as typeof Gtk;
  _Gdk = _gi.Gdk as typeof Gdk;
  _Gio = _gi.Gio as typeof Gio;
  _GLib = _gi.GLib as typeof GLib;

  try {
    _gi.versions.WebKit = '6.0';
    _WebKit = _gi.WebKit as typeof WebKit;
  } catch {
    try {
      _gi.versions.WebKit2 = '4.1';
      _WebKit = _gi.WebKit2 as typeof WebKit;
    } catch (e) {
      console.error('[gjs-gtk4] Could not load WebKit namespace:', e);
      _WebKit = null as unknown as typeof WebKit;
    }
  }
}

export function ensureGtkApp(): void {
  if (_gtkApp) return;
  ensureGiLoaded();
  _gtkApp = new _Gtk.Application({ application_id: 'org.nodejs.nww' }) as Gtk.Application;
  _gtkApp.connect('activate', () => {
    _appRunning = true;
    const callbacks = _pendingWindowCreations.splice(0);
    for (const fn of callbacks) fn();
  });
}
