/**
 * Tests for bridge script generation and HTML injection.
 *
 * We verify the *shape* of the generated JavaScript strings — that the right
 * APIs are present and the injection lands in the right place — without
 * actually executing the renderer-side code.
 */
import { describe, it, expect } from 'vitest';
import {
  generateBridgeScript as generateWpf,
  injectBridgeScript  as injectWpf,
} from '../../src/backend/netfx-wpf/bridge.js';
import {
  generateBridgeScript as generateGjs,
  injectBridgeScript  as injectGjs,
} from '../../src/backend/gjs-gtk4/bridge.js';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function wpfScript(prefs = {}, port = 0) {
  return generateWpf(prefs, port);
}

function gjsScript(prefs = {}, port = 0) {
  return generateGjs(prefs, port);
}

// ──────────────────────────────────────────────────────────────────────────────
// IPC bridge (contextIsolation: false, the default)
// ──────────────────────────────────────────────────────────────────────────────

describe('WPF bridge — IPC section (contextIsolation: false)', () => {
  it('includes window.ipcRenderer', () => {
    expect(wpfScript()).toContain('window.ipcRenderer');
  });

  it('includes send, invoke, sendSync, on, once, off', () => {
    const script = wpfScript();
    expect(script).toContain('send:function');
    expect(script).toContain('invoke:function');
    expect(script).toContain('sendSync:function');
    expect(script).toContain('on:function');
    expect(script).toContain('once:function');
    expect(script).toContain('off:function');
  });

  it('sendSync calls the /__nww_ipc_sync__ endpoint', () => {
    const script = wpfScript({}, 12345);
    expect(script).toContain('/__nww_ipc_sync__');
    expect(script).toContain('12345');
  });

  it('sendSync port is 0 when no syncServerPort is provided', () => {
    const script = wpfScript();
    expect(script).toContain('/__nww_ipc_sync__');
    // Port 0 baked in
    expect(script).toContain('127.0.0.1:0/');
  });

  it('omits ipcRenderer when contextIsolation is true', () => {
    const script = wpfScript({ contextIsolation: true });
    expect(script).not.toContain('window.ipcRenderer');
  });

  it('uses chrome.webview.postMessage for send/invoke', () => {
    const script = wpfScript();
    expect(script).toContain('chrome.webview.postMessage');
  });
});

describe('GJS bridge — IPC section (contextIsolation: false)', () => {
  it('includes window.ipcRenderer', () => {
    expect(gjsScript()).toContain('window.ipcRenderer');
  });

  it('includes send, invoke, sendSync, on, once, off', () => {
    const script = gjsScript();
    expect(script).toContain('send:');
    expect(script).toContain('invoke:');
    expect(script).toContain('sendSync:');
    expect(script).toContain('on:');
    expect(script).toContain('once:');
    expect(script).toContain('off:');
  });

  it('sendSync calls the /__nww_ipc_sync__ endpoint', () => {
    const script = gjsScript({}, 54321);
    expect(script).toContain('/__nww_ipc_sync__');
    expect(script).toContain('54321');
  });

  it('omits ipcRenderer when contextIsolation is true', () => {
    const script = gjsScript({ contextIsolation: true });
    expect(script).not.toContain('window.ipcRenderer');
  });

  it('uses webkit.messageHandlers.ipc.postMessage for send/invoke', () => {
    const script = gjsScript();
    expect(script).toContain('webkit.messageHandlers.ipc.postMessage');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Node bridge (nodeIntegration: true)
// ──────────────────────────────────────────────────────────────────────────────

describe('WPF bridge — node integration section', () => {
  it('omits node bridge when nodeIntegration is false/absent', () => {
    expect(wpfScript()).not.toContain('window.require');
    expect(wpfScript()).not.toContain('window.process');
  });

  it('includes window.require when nodeIntegration is true', () => {
    const script = wpfScript({ nodeIntegration: true }, 9999);
    expect(script).toContain('window.require');
  });

  it('includes window.process when nodeIntegration is true', () => {
    const script = wpfScript({ nodeIntegration: true }, 9999);
    expect(script).toContain('window.process');
    expect(script).toContain('platform');
    expect(script).toContain('win32');
  });

  it('injects the sync server port into require calls', () => {
    const script = wpfScript({ nodeIntegration: true }, 8080);
    expect(script).toContain('127.0.0.1:8080');
    expect(script).toContain('/__nww_sync__');
  });

  it('includes SSE EventSource when nodeIntegration is true and port > 0', () => {
    const script = wpfScript({ nodeIntegration: true }, 7777);
    expect(script).toContain('EventSource');
    expect(script).toContain('/__nww_events__');
  });
});

describe('GJS bridge — node integration section', () => {
  it('omits window.require when nodeIntegration is false/absent', () => {
    expect(gjsScript()).not.toContain('window.require');
  });

  it('includes window.require when nodeIntegration is true and port > 0', () => {
    const script = gjsScript({ nodeIntegration: true }, 9999);
    expect(script).toContain('window.require');
  });

  it('uses webkit IPC for process.exit instead of chrome.webview', () => {
    const script = gjsScript({ nodeIntegration: true }, 9999);
    expect(script).toContain('webkit.messageHandlers.ipc.postMessage');
    expect(script).not.toContain('chrome.webview');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// HTML injection
// ──────────────────────────────────────────────────────────────────────────────

describe('WPF injectBridgeScript', () => {
  it('injects into <head> when present', () => {
    const html = '<html><head></head><body></body></html>';
    const result = injectWpf(html, {});
    expect(result).toMatch(/<head><script>/);
  });

  it('injects into <body> when no <head>', () => {
    const html = '<html><body></body></html>';
    const result = injectWpf(html, {});
    expect(result).toMatch(/<body><script>/);
  });

  it('prepends to document when neither <head> nor <body>', () => {
    const html = '<div>hello</div>';
    const result = injectWpf(html, {});
    expect(result.startsWith('<script>')).toBe(true);
  });

  it('result contains closing </script> tag', () => {
    const result = injectWpf('<html><head></head></html>', {});
    expect(result).toContain('</script>');
  });

  it('passes syncServerPort into the injected script', () => {
    const result = injectWpf('<html><head></head></html>', { nodeIntegration: true }, 3333);
    expect(result).toContain('3333');
  });
});

describe('GJS injectBridgeScript', () => {
  it('injects into <head> when present', () => {
    const html = '<html><head></head><body></body></html>';
    const result = injectGjs(html, {});
    expect(result).toMatch(/<head><script>/);
  });

  it('injects into <body> when no <head>', () => {
    const html = '<html><body></body></html>';
    const result = injectGjs(html, {});
    expect(result).toMatch(/<body><script>/);
  });

  it('passes syncServerPort into the injected script', () => {
    const result = injectGjs('<html><head></head></html>', { nodeIntegration: true }, 4444);
    expect(result).toContain('4444');
  });
});
