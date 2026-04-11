import type { DotnetRef, ConstructableDotnetRef } from '@devscholar/node-ps1-dotnet';

export type { DotnetRef, ConstructableDotnetRef };

export type DotNetObject = DotnetRef;

type SystemNamespace = {
    Uri: ConstructableDotnetRef;
    IntPtr: DotnetRef;
    Convert: DotnetRef & { ToBase64String(bytes: any): string };
    Reflection: {
        Assembly: DotnetRef & { LoadFrom(path: string): DotnetRef; GetType(name: string): ConstructableDotnetRef };
    };
    IO: {
        MemoryStream: ConstructableDotnetRef;
        StreamReader: ConstructableDotnetRef;
    };
    Drawing: {
        Icon: DotnetRef;
        Color: DotnetRef;
    };
    Windows: {
        Thickness: ConstructableDotnetRef;
        WindowState: DotnetRef & { Minimized: DotnetRef; Maximized: DotnetRef; Normal: DotnetRef };
        Window: ConstructableDotnetRef;
        WindowStartupLocation: DotnetRef & { CenterScreen: DotnetRef; Manual: DotnetRef };
        WindowStyle: DotnetRef & { None: DotnetRef; SingleBorderWindow: DotnetRef };
        ResizeMode: DotnetRef & { NoResize: DotnetRef; CanResize: DotnetRef };
        Application: ConstructableDotnetRef;
        SystemParameters: DotnetRef & { PrimaryScreenWidth: number; PrimaryScreenHeight: number };
        Media: {
            Brushes: DotnetRef & { Transparent: DotnetRef };
            Imaging: {
                BitmapFrame: DotnetRef;
                BitmapImage: ConstructableDotnetRef;
            };
        };
        Interop: {
            WindowInteropHelper: ConstructableDotnetRef;
        };
        Shell: {
            WindowChrome: ConstructableDotnetRef;
        };
        Controls: {
            Menu: ConstructableDotnetRef;
            MenuItem: ConstructableDotnetRef;
            Separator: ConstructableDotnetRef;
            ContextMenu: ConstructableDotnetRef;
            Grid: ConstructableDotnetRef;
            DockPanel: ConstructableDotnetRef & { SetDock(element: any, dock: number): void };
            Image: ConstructableDotnetRef;
            PlacementMode: DotnetRef & { AbsolutePoint: DotnetRef };
        };
    };
};

export interface DotnetProxy extends DotnetRef {
    (namespace: string): DotnetRef;
    System: SystemNamespace;
    load(nameOrPath: string): DotnetRef;
    frameworkMoniker: string;
    runtimeVersion: string;
    awaitTask(task: DotNetObject): Promise<DotNetObject>;
    addType(source: string, references?: string[]): DotnetRef;
    startApplication(app: DotNetObject, window: DotNetObject): void;
    addListener(event: string, fn: (...args: unknown[]) => void): void;
    pollEvent(): boolean;
    getHwnd(win: DotNetObject): string;
    minimize(win: DotNetObject): void;
    setFullScreen(win: DotNetObject, flag: boolean, needFrameless: boolean, alwaysOnTop: boolean): void;
    applyWindowChrome(win: DotNetObject): void;
    applyHiddenTitleBar(win: DotNetObject): void;
    setWindowIcon(win: DotNetObject, iconPath: string): void;
    setOwnerByHwnd(win: DotNetObject, ownerHwnd: string): void;
    setWindowEnabled(win: DotNetObject, enabled: boolean): void;
    setWebViewBackground(wv: DotNetObject, a: number, r: number, g: number, b: number): void;
    capturePreview(wv: DotNetObject): string;
    trashItem(filePath: string): void;
    winHelper(win: DotNetObject, op: string, flag?: boolean): void;
    registerWindowAccelerators(win: DotNetObject, shortcuts: Array<{ vk: number; modifiers: number; callbackId: string }>): void;
    addScriptAndNavigate(coreWebView2: DotNetObject, script: string, url: string): void;
    addScriptAndNavigateToString(coreWebView2: DotNetObject, script: string, html: string): void;
    setSchemeAllowedOrigins(reg: DotNetObject, origins: string[]): void;
}
