import { protocol, ensureProtocolWorker, callHandlerSync } from '../../protocol.js';
import { handleNwwRequest } from '../../node-integration.js';
import type { WebPreferences } from '../../interfaces.js';
import type { DotnetProxy, DotNetObject } from './dotnet/types.js';

/**
 * Initialize WebView2 using CoreWebView2Environment.CreateAsync() so that nww://
 * (node integration) and any user custom schemes are registered before the webview
 * environment is created.  Adds the WebResourceRequested handler for nww:// and
 * custom protocols.  Must be called after the WPF Application has started.
 */
export async function initWebView2WithProtocols(
  coreAssembly: DotNetObject,
  webView: DotNetObject,
  webPreferences: WebPreferences,
  userDataPath: string,
  dotnet: DotnetProxy,
): Promise<void> {
  const EnvType    = coreAssembly.GetType('Microsoft.Web.WebView2.Core.CoreWebView2Environment');
  const OptsType   = coreAssembly.GetType('Microsoft.Web.WebView2.Core.CoreWebView2EnvironmentOptions');
  const SchemeType = coreAssembly.GetType('Microsoft.Web.WebView2.Core.CoreWebView2CustomSchemeRegistration');

  const nwwReg: DotNetObject = new SchemeType('nww');
  nwwReg.TreatAsSecure = true;
  nwwReg.HasAuthorityComponent = true;
  dotnet.setSchemeAllowedOrigins(nwwReg, ['*']);

  const schemeRegs: unknown[] = [nwwReg];
  for (const [scheme, priv] of protocol.getRegisteredSchemes()) {
    const reg: DotNetObject = new SchemeType(scheme);
    reg.TreatAsSecure = priv.secure ?? false;
    reg.HasAuthorityComponent = priv.standard ?? false;
    schemeRegs.push(reg);
  }

  const opts: DotNetObject = new OptsType(null, null, null, false, schemeRegs);
  const disableWebSecurity =
    webPreferences.webSecurity === false ||
    webPreferences.nodeIntegration === true;
  if (disableWebSecurity) {
    opts.AdditionalBrowserArguments = '--disable-web-security';
  }

  try {
    const env = await dotnet.awaitTask(
      EnvType.CreateAsync(null, userDataPath, opts),
    );
    await dotnet.awaitTask(webView.EnsureCoreWebView2Async(env));
  } catch (e) {
    console.error('[node-with-window] EnsureCoreWebView2Async failed:', e);
    return;
  }

  const coreWV2 = webView.CoreWebView2 as DotNetObject;
  const ALL = 0; // CoreWebView2WebResourceContext.All
  coreWV2.AddWebResourceRequestedFilter('nww://*', ALL);
  for (const [scheme] of protocol.getRegisteredSchemes()) {
    coreWV2.AddWebResourceRequestedFilter(`${scheme}://*`, ALL);
  }

  // Spawn protocol worker for user-registered handlers (if any).
  if (protocol.getRegisteredSchemes().size > 0) {
    ensureProtocolWorker(protocol.getAllHandlers());
  }

  // FireSyncEventAndWait already extracts Request.Uri/Method into inlineProps
  // and creates WebResourceResponse from the callback return value.
  // callHandlerSync uses Atomics.wait+SharedArrayBuffer (no IPC pipe), so it
  // is safe at syncEventDepth=1.
  (coreWV2 as DotNetObject).add_WebResourceRequested((_s: unknown, e: unknown) => {
    const ev = e as DotNetObject;
    const uri: string  = ev.Request.Uri;
    const meth: string = ev.Request.Method;
    const colonIdx = uri.indexOf('://');
    const scheme   = colonIdx >= 0 ? uri.slice(0, colonIdx) : '';

    // nww:// is handled directly on the main thread (no worker thread needed).
    if (scheme === 'nww') {
      // CORS preflight: return 204 with CORS headers immediately.
      if (meth === 'OPTIONS') {
        return {
          html:         '',
          statusCode:   204,
          reasonPhrase: 'No Content',
          headers:      'Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type',
          base64:       false,
        };
      }
      let body: string | null = null;
      const contentStream = ev.Request.Content;
      if (contentStream != null) {
        try {
          const reader = new dotnet.System.IO.StreamReader(contentStream);
          body = reader.ReadToEnd() as string;
          reader.Dispose();
        } catch { /* no body */ }
      }
      const nwwResult = handleNwwRequest(uri, meth, body);
      return {
        html:         nwwResult.body,
        statusCode:   nwwResult.status,
        reasonPhrase: nwwResult.status === 200 ? 'OK' : 'Error',
        headers:      `Content-Type: ${nwwResult.mimeType}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type`,
        base64:       false,
      };
    }

    const result = callHandlerSync(scheme, uri, meth);
    const contentType = result.mimeType ?? (result.isBase64 ? 'application/octet-stream' : 'text/html; charset=utf-8');
    return {
      html:         result.body,
      statusCode:   result.statusCode,
      reasonPhrase: result.statusCode === 200 ? 'OK' : 'Error',
      headers:      `Content-Type: ${contentType}`,
      base64:       result.isBase64,
    };
  });
}
