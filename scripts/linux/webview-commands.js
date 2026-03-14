// webview-commands.js
// GJS commands that operate on the WebKit WebView:
// navigation, script injection, renderer messaging, poll, devtools.
import WebKit from 'gi://WebKit?version=6.0';

export function handleWebViewCommand(cmd, webView, cm, ipcQueue, isClosed) {
    switch (cmd.action) {

        case 'LoadURL': {
            if (webView) webView.load_uri(cmd.url);
            return { type: 'void' };
        }

        case 'LoadHTML': {
            if (webView) webView.load_html(cmd.html, cmd.baseUri || null);
            return { type: 'void' };
        }

        case 'SetUserScript': {
            if (cm && cmd.code) {
                const script = new WebKit.UserScript(
                    cmd.code,
                    WebKit.UserContentInjectedFrames.ALL_FRAMES,
                    WebKit.UserScriptInjectionTime.START,
                    null,
                    null
                );
                cm.add_script(script);
            }
            return { type: 'void' };
        }

        case 'SendToRenderer': {
            if (webView) {
                // Fire-and-forget: we don't need the JS return value.
                webView.evaluate_javascript(cmd.script, -1, null, null, null, () => {});
            }
            return { type: 'void' };
        }

        // Node.js calls Poll periodically (every ~16 ms) to drain the renderer IPC queue.
        case 'Poll': {
            if (isClosed())          return { type: 'exit' };
            if (ipcQueue.length > 0) return { type: 'ipc', message: ipcQueue.shift() };
            return { type: 'none' };
        }

        case 'Reload': {
            if (webView) webView.reload();
            return { type: 'void' };
        }

        case 'OpenDevTools': {
            if (webView) {
                const inspector = webView.get_inspector();
                if (inspector) inspector.show();
            }
            return { type: 'void' };
        }

        default:
            return null; // not handled here
    }
}
