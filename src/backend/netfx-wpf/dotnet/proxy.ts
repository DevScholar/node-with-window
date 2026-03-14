import { getIpc } from './state.js';

export let node_ps1_dotnetGetter: (() => any) | null = null;

export function setNodePs1Dotnet(fn: () => any) {
    node_ps1_dotnetGetter = fn;
}

export function getNodePs1Dotnet() {
    if (node_ps1_dotnetGetter) {
        return node_ps1_dotnetGetter();
    }
    throw new Error('node_ps1_dotnet not initialized');
}

const gcRegistry = new FinalizationRegistry((id: string) => {
    try { getNodePs1Dotnet()._release(id); } catch {}
});

export const callbackRegistry = new Map<string, Function>();
export const typeMetadataCache = new Map<string, Map<string, string>>();
export const globalTypeCache = new Map<string, Map<string, string>>();
export const typeNameCache = new Map<string, string>();

// When true (after startApplication), Task results are fire-and-forget instead of
// synchronously blocked via AwaitTask. This prevents deadlocks in polling mode where
// task.Wait() on the WPF UI thread blocks the dispatcher that the task needs to complete.
export let pollingMode = false;
export function setPollingMode(val: boolean) { pollingMode = val; }
export const LARGE_ARRAY_THRESHOLD = 50;

export function getObjectTypeName(id: string): string | null {
    const ipc = getIpc();
    if (typeNameCache.has(id)) {
        return typeNameCache.get(id)!;
    }
    try {
        const res = ipc!.send({ action: 'GetTypeName', targetId: id });
        if (res && res.typeName) {
            typeNameCache.set(id, res.typeName);
            return res.typeName;
        }
    } catch {}
    return null;
}

export function getTypeMembers(typeName: string, memberNames: string[]): Map<string, string> | null {
    const ipc = getIpc();
    if (globalTypeCache.has(typeName)) {
        const cached = globalTypeCache.get(typeName)!;
        const result = new Map<string, string>();
        let allFound = true;
        for (const name of memberNames) {
            if (cached.has(name)) {
                result.set(name, cached.get(name)!);
            } else {
                allFound = false;
            }
        }
        if (allFound) return result;
    }

    try {
        const res = ipc!.send({ action: 'InspectType', typeName, memberNames });
        if (res && res.members) {
            if (!globalTypeCache.has(typeName)) {
                globalTypeCache.set(typeName, new Map());
            }
            const cache = globalTypeCache.get(typeName)!;
            for (const [name, type] of Object.entries(res.members as Record<string, string>)) {
                cache.set(name, type);
            }
            return new Map(Object.entries(res.members as Record<string, string>));
        }
    } catch {}
    return null;
}

export function ensureMemberTypeCached(id: string, memberName: string, memberCache: Map<string, string>) {
    if (memberCache.has(memberName)) return;

    const typeName = getObjectTypeName(id);
    if (typeName) {
        const members = getTypeMembers(typeName, [memberName]);
        if (members && members.has(memberName)) {
            memberCache.set(memberName, members.get(memberName)!);
            return;
        }
    }

    const ipc = getIpc();
    try {
        const inspectRes = ipc!.send({ action: 'Inspect', targetId: id, memberName });
        memberCache.set(memberName, inspectRes.memberType ?? 'property');
    } catch {
        memberCache.set(memberName, 'property');
    }
}

export function createLazyArray(arr: any[]): any {
    return new Proxy(arr, {
        get(target, prop) {
            if (typeof prop === 'symbol') return (target as any)[prop];
            const index = Number(prop);
            if (!isNaN(index) && index >= 0 && index < target.length) {
                return createProxy(target[index]);
            }
            if (prop === 'length') return target.length;
            if (prop === 'map' || prop === 'filter' || prop === 'forEach' || prop === 'reduce') {
                return (...args: any[]) => {
                    const transformed = target.map((item: any) => createProxy(item));
                    const method = (transformed as any)[prop];
                    return method.call(transformed, ...args);
                };
            }
            if (prop === 'slice') {
                return (...args: any[]) => {
                    const sliced = target.slice(...args);
                    return sliced.map((item: any) => createProxy(item));
                };
            }
            return undefined;
        }
    });
}

// Marshal JS args to .NET-compatible format: refs by ID, functions as callbacks.
function marshalArgs(args: any[]): any[] {
    return args.map((a: any) => {
        if (a && a.__ref) return { __ref: a.__ref };
        if (typeof a === 'function') {
            const cbId = `cb_arg_${Date.now()}_${Math.random()}`;
            callbackRegistry.set(cbId, a);
            return { type: 'callback', callbackId: cbId };
        }
        return a;
    });
}

// Core proxy factory for a .NET object reference.
// inlineProps: pre-fetched property values attached to event args, avoids extra round-trips.
function makeRefProxy(id: string, inlineProps?: Record<string, any>): any {
    const ipc = getIpc();

    if (!typeMetadataCache.has(id)) {
        typeMetadataCache.set(id, new Map());
    }
    const memberCache = typeMetadataCache.get(id)!;

    class Stub {}

    const proxy = new Proxy(Stub, {
        get: (_target: any, prop: string) => {
            if (prop === '__ref') return id;
            if (prop === '__inlineProps') return inlineProps;
            if (typeof prop !== 'string') return undefined;

            // Fast path: use pre-fetched inline props (typically on event args).
            if (inlineProps && Object.prototype.hasOwnProperty.call(inlineProps, prop)) {
                memberCache.set(prop, 'property');
                return inlineProps[prop];
            }

            if (prop.startsWith('add_')) {
                const eventName = prop.substring(4);
                return (callback: Function) => {
                    const cbId = `cb_${Date.now()}_${Math.random()}`;
                    callbackRegistry.set(cbId, callback);
                    ipc!.send({ action: 'AddEvent', targetId: id, eventName, callbackId: cbId });
                };
            }

            let memType = memberCache.get(prop);
            if (!memType) {
                ensureMemberTypeCached(id, prop, memberCache);
                memType = memberCache.get(prop);
            }

            if (memType === 'property') {
                const res = ipc!.send({ action: 'Invoke', targetId: id, methodName: prop, args: [] });
                return createProxy(res);
            } else {
                return (...args: any[]) => {
                    const res = ipc!.send({ action: 'Invoke', targetId: id, methodName: prop, args: marshalArgs(args) });
                    return createProxy(res);
                };
            }
        },

        set: (_target: any, prop: string, value: any) => {
            if (typeof prop !== 'string') return false;
            const netArg = (value && value.__ref) ? { __ref: value.__ref } : value;
            ipc!.send({ action: 'Invoke', targetId: id, methodName: prop, args: [netArg] });
            memberCache.set(prop, 'property');
            return true;
        },

        construct: (_target: any, args: any[]) => {
            const res = ipc!.send({ action: 'New', typeId: id, args: marshalArgs(args) });
            return createProxy(res);
        },

        apply: () => { throw new Error("Cannot call .NET object as a function. Need 'new'?"); }
    });

    gcRegistry.register(proxy, id);
    return proxy;
}

export function createProxyWithInlineProps(meta: any): any {
    if (meta.type !== 'ref') return createProxy(meta);
    return makeRefProxy(meta.id, meta.props || {});
}

export function createProxy(meta: any): any {
    const ipc = getIpc();

    if (meta.type === 'primitive' || meta.type === 'null') return meta.value;

    if (meta.type === 'array') {
        const arr = meta.value;
        if (arr.length <= LARGE_ARRAY_THRESHOLD) {
            return arr.map((item: any) => createProxy(item));
        }
        return createLazyArray(arr);
    }

    if (meta.type === 'task') {
        const taskId = meta.id;
        // In polling mode, awaiting via task.Wait() on the WPF UI thread deadlocks.
        // Release the task reference and return null (fire-and-forget).
        if (pollingMode) {
            try { ipc!.send({ action: 'Release', targetId: taskId }); } catch {}
            return null;
        }
        return new Promise((resolve, reject) => {
            try {
                const res = ipc!.send({ action: 'AwaitTask', taskId: taskId });
                resolve(createProxy(res));
            } catch (e) {
                reject(e);
            } finally {
                try { ipc!.send({ action: 'Release', targetId: taskId }); } catch {}
            }
        });
    }

    if (meta.type === 'namespace') {
        const nsName = meta.value;
        const dotnet = getNodePs1Dotnet();
        return new Proxy({}, {
            get: (_target: any, prop: string) => {
                if (typeof prop !== 'string') return undefined;
                return dotnet._load(`${nsName}.${prop}`);
            }
        });
    }

    if (meta.type !== 'ref') return null;

    return makeRefProxy(meta.id);
}
