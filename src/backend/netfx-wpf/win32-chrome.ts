import { BrowserWindowOptions } from '../../interfaces.js';
import type { DotnetProxy } from './dotnet/types.js';

/**
 * Manages Win32 P/Invoke window chrome for a single WPF window:
 * button visibility (minimize/maximize/close), movability, taskbar presence,
 * size constraints, and HWND-level helpers.
 *
 * All state is owned here so NetFxWpfWindow doesn't accumulate these fields.
 * Uses lazy getters so it can be constructed before the HWND exists.
 * Call apply() once after Application.Run() / Show() to flush deferred state.
 */
export class Win32Chrome {
  private _isMinimizable: boolean;
  private _isMaximizable: boolean;
  private _isClosable: boolean;
  private _isMovable: boolean;
  private _skipTaskbar: boolean;
  private _pendingMinSize: [number, number] | null = null;
  private _pendingMaxSize: [number, number] | null = null;

  constructor(
    private readonly getBrowserWindow: () => unknown,
    private readonly getDotnet: () => DotnetProxy,
    options: BrowserWindowOptions,
  ) {
    this._isMinimizable = options.minimizable  ?? true;
    this._isMaximizable = options.maximizable  ?? true;
    this._isClosable    = options.closable     ?? true;
    this._isMovable     = options.movable      ?? true;
    this._skipTaskbar   = options.skipTaskbar  ?? false;
  }

  /**
   * Applies all pending P/Invoke chrome options that require a valid HWND.
   * Call once from show() after Application.Run() / Show().
   */
  public apply(): void {
    const bw = this.getBrowserWindow();
    if (!bw) return;
    const dotnetInst = this.getDotnet();
    if (!this._isMinimizable) dotnetInst.winHelper(bw, 'SetMinimizable', false);
    if (!this._isMaximizable) dotnetInst.winHelper(bw, 'SetMaximizable', false);
    if (!this._isClosable)   dotnetInst.winHelper(bw, 'SetClosable',    false);
    if (!this._isMovable)    dotnetInst.winHelper(bw, 'SetMovable',     false);
    if (this._skipTaskbar)   dotnetInst.winHelper(bw, 'SetSkipTaskbar', true);
    if (this._pendingMinSize) {
      (bw as any).MinWidth  = this._pendingMinSize[0];
      (bw as any).MinHeight = this._pendingMinSize[1];
      this._pendingMinSize = null;
    }
    if (this._pendingMaxSize) {
      (bw as any).MaxWidth  = this._pendingMaxSize[0] > 0 ? this._pendingMaxSize[0] : Infinity;
      (bw as any).MaxHeight = this._pendingMaxSize[1] > 0 ? this._pendingMaxSize[1] : Infinity;
      this._pendingMaxSize = null;
    }
  }

  // ── Window button visibility ───────────────────────────────────────────────

  public setMinimizable(flag: boolean): void {
    this._isMinimizable = flag;
    const bw = this.getBrowserWindow();
    if (bw) this.getDotnet().winHelper(bw, 'SetMinimizable', flag);
  }

  public isMinimizable(): boolean { return this._isMinimizable; }

  public setMaximizable(flag: boolean): void {
    this._isMaximizable = flag;
    const bw = this.getBrowserWindow();
    if (bw) this.getDotnet().winHelper(bw, 'SetMaximizable', flag);
  }

  public isMaximizable(): boolean { return this._isMaximizable; }

  public setClosable(flag: boolean): void {
    this._isClosable = flag;
    const bw = this.getBrowserWindow();
    if (bw) this.getDotnet().winHelper(bw, 'SetClosable', flag);
  }

  public isClosable(): boolean { return this._isClosable; }

  public setMovable(flag: boolean): void {
    this._isMovable = flag;
    const bw = this.getBrowserWindow();
    if (bw) this.getDotnet().winHelper(bw, 'SetMovable', flag);
  }

  public isMovable(): boolean { return this._isMovable; }

  public setSkipTaskbar(flag: boolean): void {
    this._skipTaskbar = flag;
    const bw = this.getBrowserWindow();
    if (bw) this.getDotnet().winHelper(bw, 'SetSkipTaskbar', flag);
  }

  // ── Size constraints ───────────────────────────────────────────────────────

  public setMinimumSize(width: number, height: number): void {
    const bw = this.getBrowserWindow();
    if (!bw) {
      this._pendingMinSize = [width, height];
      return;
    }
    (bw as any).MinWidth  = width;
    (bw as any).MinHeight = height;
  }

  public setMaximumSize(width: number, height: number): void {
    const bw = this.getBrowserWindow();
    if (!bw) {
      this._pendingMaxSize = [width, height];
      return;
    }
    (bw as any).MaxWidth  = width  > 0 ? width  : Infinity;
    (bw as any).MaxHeight = height > 0 ? height : Infinity;
  }

  // ── HWND helpers ───────────────────────────────────────────────────────────

  /** Returns the Win32 HWND as a decimal string (valid after show()). */
  public getHwnd(): string {
    const bw = this.getBrowserWindow();
    if (!bw) return '0';
    return this.getDotnet().getHwnd(bw) as string;
  }

  /** Enable or disable user interaction (used to block a parent for modal children). */
  public setEnabled(flag: boolean): void {
    const bw = this.getBrowserWindow();
    if (bw) this.getDotnet().setWindowEnabled(bw, flag);
  }

  /** Flash (or stop flashing) the taskbar button to attract user attention. */
  public flashFrame(flag: boolean): void {
    const bw = this.getBrowserWindow();
    if (bw) this.getDotnet().winHelper(bw, 'FlashWindow', flag);
  }
}
