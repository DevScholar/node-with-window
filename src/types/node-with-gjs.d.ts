// Minimal type declarations for @devscholar/node-with-gjs (linux-only
// optionalDependency). Lets the gjs-gtk4 backend compile on non-linux
// platforms where the package (and its @girs/* type dependencies) are not
// installed.
//
// The backend uses these GI symbols both as types and as values (`typeof Gtk`,
// `_Gtk.Orientation.VERTICAL`), exactly like the real @girs re-exports. Each
// entry is a `class` with an instance index signature (any method resolves), a
// static index signature (any static/constructor helper like
// `File.new_for_path` or `WebContext.get_default` resolves), and a variadic
// constructor (GObject props object). Where a class is also used in a *type*
// position for `Xxx.ConstructorProps`, a same-named `namespace` merges in the
// type alias. When the real package is installed its own types take precedence
// and these ambient declarations are ignored.

declare module '@devscholar/node-with-gjs' {
  export const imports: { gi: any };
  export function startEventDrain(): void;

  export class Gtk { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
  export namespace Gtk {
    export class AlertDialog { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export namespace AlertDialog { type ConstructorProps = any; }
    export class Application { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class ApplicationWindow { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class Box { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class CheckButton { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export namespace CheckButton { type ConstructorProps = any; }
    export class CssProvider { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class Dialog { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export namespace Dialog { type ConstructorProps = any; }
    export class EventControllerKey { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class FileDialog { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class Label { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class MessageDialog { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export namespace MessageDialog { type ConstructorProps = any; }
    export class Orientation { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class PopoverMenu { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class PopoverMenuBar { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class StyleContext { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
  }

  export class Gdk { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
  export namespace Gdk {
    export class Display { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class ModifierType { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class RGBA { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class Rectangle { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
  }

  export class Gio { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
  export namespace Gio {
    export class AsyncResult { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class File { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class FileIcon { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class InputStream { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class MemoryInputStream { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class Menu { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class SimpleAction { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
  }

  export class GLib { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
  export namespace GLib {
    export class Bytes { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class Error { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class MainLoop { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
  }

  export class WebKit { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
  export namespace WebKit {
    export class URISchemeRequest { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class URISchemeResponse { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export namespace URISchemeResponse { type ConstructorProps = any; }
    export class UserContentInjectedFrames { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class UserContentManager { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class UserScript { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class UserScriptInjectionTime { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class WebContext { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class WebView { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
    export class WebsiteDataManager { [key: string]: any; static [key: string]: any; constructor(...args: any[]); }
  }
}
