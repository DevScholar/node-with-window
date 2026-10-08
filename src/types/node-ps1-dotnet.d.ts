// Minimal type declarations for @devscholar/node-ps1-dotnet (win32-only
// optionalDependency). Lets the netfx-wpf backend compile on non-win32
// platforms where the package is not installed. When the real package is
// present, its own types (via package.json "exports") take precedence and
// these ambient declarations are ignored.

declare module '@devscholar/node-ps1-dotnet' {
  export type DotnetRef = any;
  export type ConstructableDotnetRef = any;
  export const callbackRegistry: Map<string, Function>;
  export function createProxy(...args: any[]): any;
  export function createProxyWithInlineProps(...args: any[]): any;
  export function releaseObject(proxy: any): void;
  const dotnetBase: any;
  export default dotnetBase;
}

declare module '@devscholar/node-ps1-dotnet/pinvoke' {
  export interface StructOptions {
    layout?: 'Sequential' | 'Explicit' | 'Auto';
    charset?: 'Auto' | 'Unicode' | 'Ansi';
    name?: string;
  }
  export function Struct(
    options?: StructOptions,
  ): (target: abstract new (...args: any[]) => any, context: ClassDecoratorContext) => void;
  export function Field(
    csType: string,
  ): (_target: undefined, context: ClassFieldDecoratorContext) => void;
  export interface DllImportOptions {
    entryPoint?: string;
    charSet?: 'Auto' | 'Unicode' | 'Ansi';
    setLastError?: boolean;
    preserveSig?: boolean;
    returns: string;
    params?: string[];
  }
  export function DllImport(
    dll: string,
    options: DllImportOptions,
  ): <T extends (...args: any[]) => any>(_target: T, context: ClassMethodDecoratorContext) => T;
  export function compilePInvoke(targets: (abstract new (...args: any[]) => any)[]): void;
}

declare module '@devscholar/node-ps1-dotnet/internal' {
  export function startApplication(app: any, window: any): void;
  export function addType(source: string, references?: string[]): any;
  export function addAsyncEvent(...args: any[]): any;
  export function addDeferredEvent(...args: any[]): any;
}
