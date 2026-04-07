/**
 * Win32 P/Invoke bindings for the netfx-wpf backend.
 * Declared in TypeScript using @DllImport/@Struct from node-ps1-dotnet/pinvoke.
 */

import { Struct, Field, DllImport, compilePInvoke } from '@devscholar/node-ps1-dotnet/pinvoke';

// ── Structs ────────────────────────────────────────────────────────────────────

@Struct()
export class FLASHWINFO {
    @Field('uint')   cbSize    = 0;
    @Field('IntPtr') hwnd      = 0n;
    @Field('uint')   dwFlags   = 0;
    @Field('uint')   uCount    = 0;
    @Field('uint')   dwTimeout = 0;
}

@Struct({ charset: 'Auto' })
export class SHFILEOPSTRUCT {
    @Field('IntPtr') hwnd                  = 0n;
    @Field('uint')   wFunc                 = 0;
    @Field('string') pFrom                 = '';
    @Field('string') pTo                   = '';
    @Field('ushort') fFlags                = 0;
    @Field('bool')   fAnyOperationsAborted = false;
    @Field('IntPtr') hNameMappings         = 0n;
    @Field('string') lpszProgressTitle     = '';
}

// ── user32.dll ────────────────────────────────────────────────────────────────

export class User32 {
    @DllImport('user32.dll', { setLastError: true, returns: 'int', params: ['IntPtr', 'int'] })
    static GetWindowLong(_hWnd: bigint, _nIndex: number): number { return 0; }

    @DllImport('user32.dll', { setLastError: true, returns: 'int', params: ['IntPtr', 'int', 'int'] })
    static SetWindowLong(_hWnd: bigint, _nIndex: number, _dwNewLong: number): number { return 0; }

    @DllImport('user32.dll', { returns: 'IntPtr', params: ['IntPtr', 'bool'] })
    static GetSystemMenu(_hWnd: bigint, _bRevert: boolean): bigint { return 0n; }

    @DllImport('user32.dll', { returns: 'bool', params: ['IntPtr', 'uint', 'uint'] })
    static EnableMenuItem(_hMenu: bigint, _uIDEnableItem: number, _uEnable: number): boolean { return false; }

    @DllImport('user32.dll', { returns: 'bool', params: ['ref FLASHWINFO'] })
    static FlashWindowEx(_pwfi: FLASHWINFO): boolean { return false; }

    @DllImport('user32.dll', { returns: 'IntPtr', params: ['IntPtr', 'uint'] })
    static GetWindow(_hWnd: bigint, _uCmd: number): bigint { return 0n; }

    @DllImport('user32.dll', { returns: 'IntPtr', params: ['IntPtr', 'uint', 'IntPtr', 'IntPtr'] })
    static SendMessage(_hWnd: bigint, _Msg: number, _wParam: bigint, _lParam: bigint): bigint { return 0n; }
}

// ── shell32.dll ───────────────────────────────────────────────────────────────

export class Shell32 {
    @DllImport('shell32.dll', { charSet: 'Auto', returns: 'int', params: ['ref SHFILEOPSTRUCT'] })
    static SHFileOperation(_lpFileOp: SHFILEOPSTRUCT): number { return 0; }

    @DllImport('shell32.dll', { preserveSig: false, returns: 'void', params: ['string'] })
    static SetCurrentProcessExplicitAppUserModelID(_AppID: string): void {}
}

// ── kernel32.dll ──────────────────────────────────────────────────────────────

export class Kernel32 {
    @DllImport('kernel32.dll', { setLastError: true, returns: 'IntPtr' })
    static GetConsoleWindow(): bigint { return 0n; }
}

// ── Compile all bindings ──────────────────────────────────────────────────────

compilePInvoke([FLASHWINFO, SHFILEOPSTRUCT, User32, Shell32, Kernel32]);

// ── Win32 constants ───────────────────────────────────────────────────────────

export const GWL_STYLE           = -16;
export const GWL_EXSTYLE         = -20;
export const WS_MINIMIZEBOX      = 0x00020000;
export const WS_MAXIMIZEBOX      = 0x00010000;
export const WS_EX_TRANSPARENT   = 0x00000020;
export const WS_EX_TOOLWINDOW    = 0x00000080;
export const WS_EX_APPWINDOW     = 0x00040000;
export const SC_CLOSE            = 0xF060;
export const MF_BYCOMMAND        = 0x00000000;
export const MF_ENABLED          = 0x00000000;
export const MF_GRAYED           = 0x00000001;
export const WM_SYSCOMMAND       = 0x0112;
export const SC_MOVE_MASK        = 0xFFF0;
export const SC_MOVE             = 0xF010;
export const FLASHW_STOP         = 0;
export const FLASHW_CAPTION      = 0x00000001;
export const FLASHW_TRAY         = 0x00000002;
export const FLASHW_ALL          = 0x00000003;
export const FLASHW_TIMERNOFG    = 0x0000000C;
export const FO_DELETE           = 0x0003;
export const FOF_ALLOWUNDO       = 0x0040;
export const FOF_NOCONFIRMATION  = 0x0010;
export const FOF_NOERRORUI       = 0x0400;
export const FOF_SILENT          = 0x0004;
export const GW_CHILD            = 5;
export const GW_HWNDNEXT         = 2;
export const WM_SETICON          = 0x0080;
export const ICON_SMALL          = 0;
export const ICON_BIG            = 1;
