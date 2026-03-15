// scripts/backend/gjs-gtk4/host.js
// GJS host script for the node-with-window Linux backend.
// Spawned by GjsGtk4Window via: gjs -m host.js
// IPC: fd 3 = read commands from Node.js, fd 4 = write responses to Node.js
//
// Protocol (JSON lines):
//   Node.js -> GJS: { action, ...params }
//   GJS -> Node.js: { type: 'void' | 'result' | 'error' | 'ipc' | 'none' | 'exit', ... }
//
// The 'Poll' action is called periodically by Node.js to drain the ipcQueue
// (messages posted by the HTML page via window.webkit.messageHandlers.ipc).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import { handleWindowCommand } from './window-commands.js';
import { handleWebViewCommand } from './webview-commands.js';
import { showOpenDialog, showSaveDialog, showMessageBox } from './dialog-commands.js';

// ---------------------------------------------------------------------------
// Stream setup — fd 3 (Node.js -> GJS), fd 4 (GJS -> Node.js)
// ---------------------------------------------------------------------------

let UnixInputStream, UnixOutputStream;
try {
    const GioUnix = imports.gi.GioUnix;
    UnixInputStream = GioUnix.InputStream;
    UnixOutputStream = GioUnix.OutputStream;
} catch (_e) {
    UnixInputStream = Gio.UnixInputStream;
    UnixOutputStream = Gio.UnixOutputStream;
}

if (!UnixInputStream || !UnixOutputStream) {
    printerr('node-with-window linux host: cannot find Unix stream classes');
    System.exit(1);
}

const inStream  = new UnixInputStream({ fd: 3, close_fd: false });
const outStream = new UnixOutputStream({ fd: 4, close_fd: false });
const dataIn    = new Gio.DataInputStream({ base_stream: inStream });
const dataOut   = new Gio.DataOutputStream({ base_stream: outStream });

// ---------------------------------------------------------------------------
// Shared mutable state (passed by reference into sub-modules via wrappers)
// ---------------------------------------------------------------------------

const ipcQueue = [];

// Box-wrapped values so sub-modules can mutate them through the shared object.
const state = {
    gtkWindow:        null,
    webView:          null,
    cm:               null,  // WebKit.UserContentManager
    mainLoop:         null,
    windowBoxRef:     { value: null },
    iconPathRef:      { value: null },
    isClosedRef:      { value: false },
    alwaysOnTopPending: false,  // set_keep_above failed in CreateWindow; retry after Show
    ipcQueue,
    menuActions:      null,  // initialised after Gtk.init() in CreateWindow
    menuActionIndexRef: { value: 0 },
};

// ---------------------------------------------------------------------------
// IPC output helper
// ---------------------------------------------------------------------------

function writeLine(obj) {
    try {
        dataOut.put_string(JSON.stringify(obj) + '\n', null);
    } catch (_e) {
        System.exit(0);
    }
}

// ---------------------------------------------------------------------------
// Command dispatcher
// ---------------------------------------------------------------------------

function executeCommand(cmd) {
    // Initialise the Gio.SimpleActionGroup once Gtk is available (after CreateWindow).
    if (cmd.action === 'CreateWindow') {
        state.menuActions = new Gio.SimpleActionGroup();
    }

    // Try window-level commands first (CreateWindow, Show, title, size, etc.)
    const windowResult = handleWindowCommand(cmd, state);
    if (windowResult !== null) return windowResult;

    // Then WebView commands (LoadURL, Poll, SendToRenderer, etc.)
    const webViewResult = handleWebViewCommand(
        cmd,
        state.webView,
        state.cm,
        ipcQueue,
        () => state.isClosedRef.value
    );
    if (webViewResult !== null) return webViewResult;

    // Dialog commands
    switch (cmd.action) {
        case 'ShowOpenDialog':  return showOpenDialog(state.gtkWindow, cmd.options || {});
        case 'ShowSaveDialog':  return showSaveDialog(state.gtkWindow, cmd.options || {});
        case 'ShowMessageBox':  return showMessageBox(state.gtkWindow, cmd.options || {});
    }

    return { type: 'error', message: `Unknown action: ${cmd.action}` };
}

// ---------------------------------------------------------------------------
// IO watch — receive commands from Node.js while the GLib main loop runs
// ---------------------------------------------------------------------------

function bindIPCEvent() {
    const channel = GLib.IOChannel.unix_new(3);
    GLib.io_add_watch(channel, GLib.PRIORITY_DEFAULT, GLib.IOCondition.IN, () => {
        try {
            const [line] = dataIn.read_line_utf8(null);
            if (!line) {
                if (state.mainLoop) state.mainLoop.quit();
                return GLib.SOURCE_REMOVE;
            }

            let cmd;
            try { cmd = JSON.parse(line); }
            catch (_e) {
                writeLine({ type: 'error', message: `Invalid JSON: ${line}` });
                return GLib.SOURCE_CONTINUE;
            }

            let response;
            try { response = executeCommand(cmd); }
            catch (e) { response = { type: 'error', message: String(e) }; }

            writeLine(response);
        } catch (_e) {
            if (state.mainLoop) state.mainLoop.quit();
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

bindIPCEvent();

state.mainLoop = GLib.MainLoop.new(null, false);
state.mainLoop.run();
