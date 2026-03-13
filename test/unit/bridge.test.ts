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
  injectImportMap,
} from '../../src/backend/netfx-wpf/bridge.js';
import {
  generateBridgeScript as generateGjs,
  injectBridgeScript  as injectGjs,
} from '../../src/backend/gjs-gtk4/bridge.js';
import {
  NODE_BUILTINS,
  generateImportMapTag,
} from '../../src/esm-importmap.js';

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

  it('embeds importmap JSON and MutationObserver injector when port > 0', () => {
    const script = wpfScript({ nodeIntegration: true }, 5000);
    expect(script).toContain('__nww_esm__');
    expect(script).toContain('MutationObserver');
    expect(script).toContain('__nwwDoInjectImportMap');
    expect(script).toContain('__nww_esm__/fs');
    expect(script).toContain('node:fs');
  });

  it('does not embed importmap when port is 0', () => {
    const script = wpfScript({ nodeIntegration: true }, 0);
    expect(script).not.toContain('MutationObserver');
    expect(script).not.toContain('__nww_esm__');
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

  it('embeds importmap JSON and MutationObserver injector when port > 0', () => {
    const script = gjsScript({ nodeIntegration: true }, 5000);
    expect(script).toContain('__nww_esm__');
    expect(script).toContain('MutationObserver');
    expect(script).toContain('__nwwDoInjectImportMap');
  });

  it('does not embed importmap when port is 0', () => {
    const script = gjsScript({ nodeIntegration: true }, 0);
    expect(script).not.toContain('MutationObserver');
    expect(script).not.toContain('__nww_esm__');
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

// ──────────────────────────────────────────────────────────────────────────────
// generateImportMapTag
// ──────────────────────────────────────────────────────────────────────────────

describe('generateImportMapTag', () => {
  it('returns a <script type="importmap"> tag', () => {
    const tag = generateImportMapTag(9999);
    expect(tag).toMatch(/^<script type="importmap">/);
    expect(tag).toContain('</script>');
  });

  it('maps bare module names to the ESM shim endpoint', () => {
    const tag = generateImportMapTag(1234);
    const map = JSON.parse(tag.replace(/<script type="importmap">|<\/script>/g, ''));
    expect(map.imports['fs']).toBe('http://127.0.0.1:1234/__nww_esm__/fs');
    expect(map.imports['path']).toBe('http://127.0.0.1:1234/__nww_esm__/path');
    expect(map.imports['os']).toBe('http://127.0.0.1:1234/__nww_esm__/os');
  });

  it('maps node: prefixed names to the same URL as the bare name', () => {
    const tag = generateImportMapTag(1234);
    const map = JSON.parse(tag.replace(/<script type="importmap">|<\/script>/g, ''));
    expect(map.imports['node:fs']).toBe(map.imports['fs']);
    expect(map.imports['node:path']).toBe(map.imports['path']);
  });

  it('includes sub-path variants like fs/promises', () => {
    const tag = generateImportMapTag(5678);
    const map = JSON.parse(tag.replace(/<script type="importmap">|<\/script>/g, ''));
    expect(map.imports['fs/promises']).toBe('http://127.0.0.1:5678/__nww_esm__/fs/promises');
    expect(map.imports['node:fs/promises']).toBe('http://127.0.0.1:5678/__nww_esm__/fs/promises');
  });

  it('covers all entries in NODE_BUILTINS (both bare and node: prefix)', () => {
    const tag = generateImportMapTag(1);
    const map = JSON.parse(tag.replace(/<script type="importmap">|<\/script>/g, ''));
    for (const name of NODE_BUILTINS) {
      expect(map.imports[name]).toBeDefined();
      expect(map.imports[`node:${name}`]).toBeDefined();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// WPF injectImportMap
// ──────────────────────────────────────────────────────────────────────────────

describe('WPF injectImportMap', () => {
  it('injects importmap into <head> when nodeIntegration is enabled', () => {
    const html = '<html><head></head><body></body></html>';
    const result = injectImportMap(html, { nodeIntegration: true }, 8080);
    expect(result).toContain('<script type="importmap">');
    expect(result).toContain('__nww_esm__');
    expect(result).toContain('8080');
  });

  it('does not inject importmap when nodeIntegration is false', () => {
    const html = '<html><head></head><body></body></html>';
    const result = injectImportMap(html, { nodeIntegration: false }, 8080);
    expect(result).not.toContain('importmap');
    expect(result).toBe(html); // unchanged
  });

  it('does not inject importmap when port is 0', () => {
    const html = '<html><head></head><body></body></html>';
    const result = injectImportMap(html, { nodeIntegration: true }, 0);
    expect(result).not.toContain('importmap');
  });

  it('injects <base> tag before importmap when baseHref is provided', () => {
    const html = '<html><head></head></html>';
    const result = injectImportMap(html, { nodeIntegration: true }, 9000, 'file:///app/');
    // base must come before importmap in the HTML
    const basePos = result.indexOf('<base ');
    const mapPos  = result.indexOf('<script type="importmap">');
    expect(basePos).toBeGreaterThan(-1);
    expect(mapPos).toBeGreaterThan(-1);
    expect(basePos).toBeLessThan(mapPos);
  });

  it('injects <base> tag even without nodeIntegration', () => {
    const html = '<html><head></head></html>';
    const result = injectImportMap(html, {}, 0, 'file:///app/');
    expect(result).toContain('<base href="file:///app/">');
    expect(result).not.toContain('importmap');
  });

  it('handles HTML without <head> by creating one', () => {
    const html = '<html><body>hi</body></html>';
    const result = injectImportMap(html, { nodeIntegration: true }, 7000);
    expect(result).toContain('<script type="importmap">');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// GJS injectBridgeScript — importmap injection
// ──────────────────────────────────────────────────────────────────────────────

describe('GJS injectBridgeScript — importmap', () => {
  it('includes importmap before bridge script when nodeIntegration + port', () => {
    const html = '<html><head></head></html>';
    const result = injectGjs(html, { nodeIntegration: true }, 5000);
    const mapPos    = result.indexOf('<script type="importmap">');
    const scriptPos = result.indexOf('<script>');
    expect(mapPos).toBeGreaterThan(-1);
    expect(scriptPos).toBeGreaterThan(-1);
    expect(mapPos).toBeLessThan(scriptPos); // importmap precedes bridge script
  });

  it('does not include importmap when nodeIntegration is false', () => {
    const html = '<html><head></head></html>';
    const result = injectGjs(html, { nodeIntegration: false }, 5000);
    expect(result).not.toContain('importmap');
  });

  it('does not include importmap when port is 0', () => {
    const html = '<html><head></head></html>';
    const result = injectGjs(html, { nodeIntegration: true }, 0);
    expect(result).not.toContain('importmap');
  });
});
