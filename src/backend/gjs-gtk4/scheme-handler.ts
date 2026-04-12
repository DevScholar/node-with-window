import { _GLib, _Gio, _WebKit } from './gtk-app.js';
import { handleNwwRequest } from '../../node-integration.js';
import { protocol } from '../../protocol.js';
import type GLib from '@girs/glib-2.0';
import type Gio from '@girs/gio-2.0';
import type WebKit from '@girs/webkit-6.0';

function readNwwBody(req: WebKit.URISchemeRequest): string | null {
  try {
    const stream = req.get_http_body?.();
    if (!stream) return null;
    const gBytes = stream.read_bytes(10 * 1024 * 1024, null);
    const data: Uint8Array = gBytes.get_data() ?? new Uint8Array(0);
    return new TextDecoder().decode(data);
  } catch {
    return null;
  }
}

export function handleNwwScheme(req: WebKit.URISchemeRequest): void {
  try {
    const uri: string    = req.get_uri();
    const method: string = req.get_http_method?.() ?? 'GET';
    const body           = method === 'POST' ? readNwwBody(req) : null;

    const result = handleNwwRequest(uri, method, body);

    const bytes = result.status === 204
      ? new Uint8Array(0)
      : new TextEncoder().encode(result.body);
    const glibBytes = new (_GLib.Bytes as unknown as new (b: Uint8Array) => GLib.Bytes)(bytes);
    const stream    = _Gio.MemoryInputStream.new_from_bytes(glibBytes);

    req.finish(stream, bytes.length, result.mimeType);
  } catch (e) {
    console.error('[gjs-gtk4] nww scheme handler error:', e);
    try { req.finish_error(e as unknown as GLib.Error); } catch { /* ignore */ }
  }
}

export async function handleUriScheme(scheme: string, request: WebKit.URISchemeRequest): Promise<void> {
  const uri: string    = request.get_uri();
  const method: string = request.get_http_method();
  const handler = protocol.getHandler(scheme);

  if (!handler) {
    try { request.finish_error(new Error(`No handler for scheme: ${scheme}`) as unknown as GLib.Error); } catch { /* ignore */ }
    return;
  }

  let result;
  try {
    result = await handler({ url: uri, method });
  } catch (e) {
    console.error(`[gjs-gtk4] Protocol handler error for ${scheme}:`, e);
    try { request.finish_error(e as unknown as GLib.Error); } catch { /* ignore */ }
    return;
  }

  try {
    const body = result.data ?? '';
    let bytes: Uint8Array;
    if (typeof body === 'string') {
      bytes = new TextEncoder().encode(body);
    } else {
      bytes = new Uint8Array((body as Buffer).buffer, (body as Buffer).byteOffset, (body as Buffer).byteLength);
    }

    const glibBytes = new (_GLib.Bytes as unknown as new (b: Uint8Array) => GLib.Bytes)(bytes);
    const stream    = _Gio.MemoryInputStream.new_from_bytes(glibBytes) as Gio.InputStream;
    const mimeType  = result.mimeType ?? 'text/html; charset=utf-8';
    const status    = result.statusCode ?? 200;

    if (status !== 200) {
      const resp = new _WebKit.URISchemeResponse(stream as unknown as WebKit.URISchemeResponse.ConstructorProps) as WebKit.URISchemeResponse;
      resp.set_status(status, null);
      resp.set_content_type(mimeType);
      request.finish_with_response(resp);
    } else {
      request.finish(stream, bytes.length, mimeType);
    }
  } catch (e) {
    console.error(`[gjs-gtk4] Protocol finish error for ${scheme}:`, e);
    try { request.finish_error(e as unknown as GLib.Error); } catch { /* ignore */ }
  }
}
