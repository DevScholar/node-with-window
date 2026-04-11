import type { DotnetRef, ConstructableDotnetRef } from '@devscholar/node-ps1-dotnet';

export type { DotnetRef, ConstructableDotnetRef };

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
    (namespace: string): any;
    System: SystemNamespace;
    load(nameOrPath: string): DotnetRef;
    frameworkMoniker: string;
    runtimeVersion: string;
    awaitTask(task: any): Promise<any>;
    addType(source: string, references?: string[]): DotnetRef;
    startApplication(app: any, window: any): void;
    addListener(event: string, fn: Function): void;
    pollEvent(): boolean;
    getHwnd(win: any): string;
    minimize(win: any): void;
    setFullScreen(win: any, flag: boolean, needFrameless: boolean, alwaysOnTop: boolean): void;
    applyWindowChrome(win: any): void;
    applyHiddenTitleBar(win: any): void;
    setWindowIcon(win: any, iconPath: string): void;
    setOwnerByHwnd(win: any, ownerHwnd: string): void;
    setWindowEnabled(win: any, enabled: boolean): void;
    setWebViewBackground(wv: any, a: number, r: number, g: number, b: number): void;
    capturePreview(wv: any): string;
    trashItem(filePath: string): void;
    winHelper(win: any, op: string, flag?: boolean): void;
    registerWindowAccelerators(win: any, shortcuts: Array<{ vk: number; modifiers: number; callbackId: string }>): void;
    addScriptAndNavigate(coreWebView2: any, script: string, url: string): void;
    addScriptAndNavigateToString(coreWebView2: any, script: string, html: string): void;
    setSchemeAllowedOrigins(reg: any, origins: string[]): void;
}
