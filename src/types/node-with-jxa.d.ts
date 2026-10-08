// Minimal type declarations for @devscholar/node-with-jxa
// This allows the jxa-cocoa backend to compile even on non-darwin platforms
// where the optionalDependency is not installed.

declare module '@devscholar/node-with-jxa' {
  export interface JxaRef {
    __ref: string;
  }

  export type JxaProxy<T extends object = object> = JxaRef & T;

  export interface ObjCMethodSpec {
    types: [string, string[]];
    implementation: (...args: any[]) => any;
  }

  export interface ObjCSubclassSpec {
    name: string;
    superclass?: string;
    protocols?: string[];
    properties?: Record<string, string>;
    methods?: Record<string, ObjCMethodSpec>;
  }

  export const ObjC: {
    import(name: string): void;
    unwrap<T = any>(value: any): T;
    deepUnwrap<T = any>(value: any): T;
    registerSubclass(spec: ObjCSubclassSpec): void;
  };

  export const $: any;

  export const callbackRegistry: Map<string, Function>;

  export function init(): void;
  export function startEventDrain(): void;
  export function drainCallbacks(): void;
  export function releaseObject(proxy: JxaRef): void;
  export function Application(name: string): any;
  export function Path(posixPath: string): any;
  export function delay(seconds: number): void;
  export function Ref(): any;

  export function addPostDrainHook(hook: () => void): void;
  export function removePostDrainHook(hook: () => void): void;

  export function registerNwwSchemeHandler(
    name: string,
    callback: (url: string, method: string, body: string | null, taskId: string) => void,
  ): any;
  export function completeNwwSchemeTask(
    taskId: string,
    result: { status?: number; mimeType?: string; body?: string } | { error: string },
  ): void;
}
