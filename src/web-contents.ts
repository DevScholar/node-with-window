import { EventEmitter } from 'node:events';

/**
 * Internal delegate interface — avoids a circular dependency between
 * WebContents and BrowserWindow.
 */
export interface WebContentsDelegate {
  sendToRenderer(channel: string, ...args: unknown[]): void;
  openDevTools(): void;
  reload(): void;
  loadURL(url: string): Promise<void>;
  loadFile(filePath: string): Promise<void>;
  executeJavaScript?(code: string): Promise<unknown>;
  onNavigationCompleted?(callback: () => void): void;
  onNavigate?(callback: (url: string) => void): void;
  onDomReady?(callback: () => void): void;
  onNavigateFailed?(callback: (errorCode: number, errorDescription: string, url: string) => void): void;
  onWillNavigate?(callback: (url: string) => void): void;
  getURL?(): string;
  getWebTitle?(): string;
  isLoading?(): boolean;
  goBack?(): void;
  goForward?(): void;
}

/**
 * Minimal Electron-compatible Session object.
 * Exposes cache/storage clearing; platform-specific HTTP cache clearing is stubbed.
 */
export class Session {
  private readonly _executeJS: (code: string) => Promise<unknown>;

  constructor(executeJS: (code: string) => Promise<unknown>) {
    this._executeJS = executeJS;
  }

  /**
   * Clears the HTTP/disk cache.
   * Full implementation requires platform WebView APIs; JS-accessible caches are cleared.
   */
  public clearCache(): Promise<void> {
    return this._executeJS('caches.keys().then(ks=>Promise.all(ks.map(k=>caches.delete(k))))')
      .then(() => void 0)
      .catch(() => void 0);
  }

  /**
   * Clears web storage.
   * @param options.storages Subset of `['localstorage','sessionstorage','indexdb','cookies']`.
   *                         Defaults to all four.
   */
  public clearStorageData(options?: { storages?: string[] }): Promise<void> {
    const storages = options?.storages ?? ['localstorage', 'sessionstorage', 'indexdb'];
    const parts: string[] = [];
    if (storages.includes('localstorage')) parts.push('localStorage.clear()');
    if (storages.includes('sessionstorage')) parts.push('sessionStorage.clear()');
    if (storages.includes('indexdb'))
      parts.push(
        '(async()=>{const dbs=await indexedDB.databases();dbs.forEach(db=>indexedDB.deleteDatabase(db.name))})()'
      );
    if (parts.length === 0) return Promise.resolve();
    return this._executeJS(parts.join(';'))
      .then(() => void 0)
      .catch(() => void 0);
  }
}

/**
 * WebContents — Electron-compatible object exposed as `win.webContents`.
 *
 * Wraps the renderer-facing operations that Electron surfaces through the
 * `webContents` property of a `BrowserWindow`.
 */
export class WebContents extends EventEmitter {
  private readonly _delegate: WebContentsDelegate;
  private readonly _session: Session;
  private _findRequestId = 0;

  /**
   * Injected into the page on first findInPage() call.
   * Defines window.__nwwFind — a stateful find controller that uses
   * TreeWalker + Range/Selection APIs to locate and highlight matches.
   */
  private static readonly _FIND_SCRIPT = `(function(){
if(window.__nwwFind)return;
window.__nwwFind={
  _r:[],_i:-1,_t:'',_c:false,_w:false,
  find:function(text,matchCase,backward,findNext,wordStart){
    if(text!==this._t||matchCase!==this._c||wordStart!==this._w||!findNext){
      this._rebuild(text,matchCase,wordStart);
    }
    if(this._r.length===0){
      var s=window.getSelection();if(s)s.removeAllRanges();
      return {matches:0,activeMatchOrdinal:0};
    }
    if(this._i===-1||!findNext){
      this._i=backward?this._r.length-1:0;
    } else if(backward){
      this._i=this._i<=0?this._r.length-1:this._i-1;
    } else {
      this._i=this._i>=this._r.length-1?0:this._i+1;
    }
    var sel=window.getSelection();
    sel.removeAllRanges();
    sel.addRange(this._r[this._i]);
    try{this._r[this._i].startContainer.parentElement.scrollIntoView({block:'nearest',inline:'nearest'});}catch(e){}
    return {matches:this._r.length,activeMatchOrdinal:this._i+1};
  },
  _rebuild:function(text,matchCase,wordStart){
    this._r=[];this._i=-1;this._t=text;this._c=matchCase;this._w=wordStart;
    if(!text)return;
    var search=matchCase?text:text.toLowerCase();
    var walker=document.createTreeWalker(document.body,4,null);
    var node;
    while(node=walker.nextNode()){
      var content=matchCase?node.textContent:node.textContent.toLowerCase();
      var pos=0,idx;
      while((idx=content.indexOf(search,pos))!==-1){
        if(wordStart){var prev=idx>0?content[idx-1]:' ';if(/\\w/.test(prev)){pos=idx+1;continue;}}
        var r=document.createRange();
        r.setStart(node,idx);r.setEnd(node,idx+search.length);
        this._r.push(r);pos=idx+1;
      }
    }
  },
  stop:function(action){
    if(action==='clearSelection'){var s=window.getSelection();if(s)s.removeAllRanges();}
    else if(action==='activateSelection'){
      var sel=window.getSelection();
      if(sel&&sel.rangeCount>0){var el=sel.getRangeAt(0).startContainer.parentElement;if(el)el.focus();}
    }
    this._r=[];this._i=-1;this._t='';
  }
};
})()`;

  constructor(delegate: WebContentsDelegate) {
    super();
    this._delegate = delegate;
    this._session = new Session(code => this.executeJavaScript(code));
    // Wire 'did-finish-load' event through the backend navigation signal.
    delegate.onNavigationCompleted?.(() => this.emit('did-finish-load'));
    delegate.onDomReady?.(() => this.emit('dom-ready'));
    delegate.onNavigate?.((url) => this.emit('did-navigate', url));
    delegate.onNavigateFailed?.((errorCode, errorDescription, url) => {
      this.emit('did-fail-load', null, errorCode, url, errorDescription, true);
    });
    delegate.onWillNavigate?.((url) => this.emit('will-navigate', url));
  }

  public send(channel: string, ...args: unknown[]): void {
    this._delegate.sendToRenderer(channel, ...args);
  }

  public openDevTools(): void {
    this._delegate.openDevTools();
  }

  public reload(): void {
    this._delegate.reload();
  }

  public loadURL(url: string): Promise<void> {
    return this._delegate.loadURL(url);
  }

  public loadFile(filePath: string): Promise<void> {
    return this._delegate.loadFile(filePath);
  }

  /**
   * Evaluates `code` in the renderer context and returns the result.
   * Supports both synchronous and Promise-returning expressions.
   */
  public executeJavaScript(code: string): Promise<unknown> {
    if (!this._delegate.executeJavaScript) {
      return Promise.reject(new Error('executeJavaScript is not supported by this backend'));
    }
    return this._delegate.executeJavaScript(code);
  }

  /** Electron-compatible session object for cache and storage management. */
  public get session(): Session {
    return this._session;
  }

  /** Returns the URL of the currently loaded page. */
  public getURL(): string {
    return this._delegate.getURL?.() ?? '';
  }

  /** Returns the title of the currently loaded page. */
  public getTitle(): string {
    return this._delegate.getWebTitle?.() ?? '';
  }

  /** Returns true if the page is currently loading. */
  public isLoading(): boolean {
    return this._delegate.isLoading?.() ?? false;
  }

  /** Navigates back in the browser history. */
  public goBack(): void {
    this._delegate.goBack?.();
  }

  /** Navigates forward in the browser history. */
  public goForward(): void {
    this._delegate.goForward?.();
  }

  /** Triggers the browser's native print dialog for the current page. */
  public print(): void {
    void this.executeJavaScript('window.print()').catch(() => {});
  }

  /**
   * Starts an in-page text search using TreeWalker + Selection/Range APIs.
   * Returns a requestId; emits `found-in-page` with the real match count.
   *
   * options.forward     — search direction (default: true)
   * options.matchCase   — case-sensitive (default: false)
   * options.findNext    — continue from current position (default: false)
   * options.wordStart   — match only at word boundaries (default: false)
   */
  public findInPage(
    text: string,
    options?: {
      forward?: boolean;
      matchCase?: boolean;
      findNext?: boolean;
      wordStart?: boolean;
    }
  ): number {
    const requestId = ++this._findRequestId;
    const backward = options?.forward === false;
    const matchCase = options?.matchCase === true;
    const findNext = options?.findNext === true;
    const wordStart = options?.wordStart === true;
    const code = `${WebContents._FIND_SCRIPT};window.__nwwFind.find(${JSON.stringify(text)},${matchCase},${backward},${findNext},${wordStart})`;
    void this.executeJavaScript(code)
      .then((res) => {
        const r = res as { matches: number; activeMatchOrdinal: number } | null;
        this.emit('found-in-page', null, {
          requestId,
          activeMatchOrdinal: r?.activeMatchOrdinal ?? 0,
          matches: r?.matches ?? 0,
          selectionArea: { x: 0, y: 0, width: 0, height: 0 },
          finalUpdate: true,
        });
      })
      .catch(() => {
        this.emit('found-in-page', null, {
          requestId,
          activeMatchOrdinal: 0,
          matches: 0,
          selectionArea: { x: 0, y: 0, width: 0, height: 0 },
          finalUpdate: true,
        });
      });
    return requestId;
  }

  /**
   * Stops any active in-page search.
   * action: 'clearSelection' (default) removes the highlight;
   *         'keepSelection' leaves the selection in place;
   *         'activateSelection' focuses the selected element.
   */
  public stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection' = 'clearSelection'): void {
    const code = `${WebContents._FIND_SCRIPT};window.__nwwFind.stop(${JSON.stringify(action)})`;
    void this.executeJavaScript(code).catch(() => {});
  }
}
