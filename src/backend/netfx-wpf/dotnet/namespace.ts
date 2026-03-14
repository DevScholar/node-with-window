import { getIpc } from './state.js';
import { createProxy } from './proxy.js';

export function createNamespaceProxy(assemblyName: string, dotnet: any) {
    return new Proxy({}, {
        get: (target: any, prop: string) => {
            if (typeof prop !== 'string') return undefined;
            if (prop === 'then') return undefined;
            
            const fullName = `${assemblyName}.${prop}`;
            const loaded = dotnet._load(fullName);
            
            let typeId: string | null = null;
            try {
                const ref = loaded.__ref;
                if (typeof ref === 'string' && ref.length > 0) {
                    typeId = ref;
                }
            } catch {}
            
            if (typeId) {
                return new Proxy({}, {
                    get: (target2: any, prop2: string) => {
                        if (typeof prop2 !== 'string') return undefined;
                        
                        if (prop2 === '__ref') {
                            return typeId;
                        }
                        
                        if (prop2 === 'value__') {
                            const ipc = getIpc();
                            try {
                                const res = ipc!.send({ action: 'Invoke', targetId: typeId, methodName: prop2, args: [] });
                                if (res && res.type === 'primitive') {
                                    return res.value;
                                }
                            } catch {}
                            return 0;
                        }
                        
                        const ipc = getIpc();
                        try {
                            const res = ipc!.send({ action: 'Invoke', targetId: typeId, methodName: prop2, args: [] });
                            if (res) {
                                if (res.type === 'primitive') {
                                    return res.value;
                                }
                                if (res.type === 'ref') {
                                    try {
                                        const valueRes = ipc!.send({ action: 'Invoke', targetId: res.id, methodName: 'value__', args: [] });
                                        if (valueRes && valueRes.type === 'primitive') {
                                            return valueRes.value;
                                        }
                                    } catch {
                                    }
                                    
                                    try {
                                        const typeNameRes = ipc!.send({ action: 'GetTypeName', targetId: res.id });
                                        const typeName = typeNameRes?.typeName || '';
                                        
                                        if (typeName && !typeName.startsWith('System.')) {
                                            try {
                                                const hashRes = ipc!.send({ action: 'Invoke', targetId: res.id, methodName: 'GetHashCode', args: [] });
                                                if (hashRes && hashRes.type === 'primitive') {
                                                    const proxy = createProxy(res);
                                                    (proxy as any).__value = hashRes.value;
                                                    return proxy;
                                                }
                                            } catch {}
                                        }
                                    } catch {}
                                    
                                    return createProxy(res);
                                }
                            }
                        } catch {}
                        
                        return (...args: any[]) => {
                            const ipc = getIpc();
                            const netArgs = args.map((a: any) => {
                                if (a && a.__ref) return { __ref: a.__ref };
                                return a;
                            });
                            const res = ipc!.send({ action: 'Invoke', targetId: typeId, methodName: prop2, args: netArgs });
                            return createProxy(res);
                        };
                    },
                    set: () => false,
                    apply: () => { throw new Error("Cannot call .NET enum as function"); }
                });
            }
            
            return loaded;
        }
    });
}

export function createExportNamespaceProxy(namespacePrefix: string, dotnet: any) {
    const cache = new Map<string, any>();
    
    return new Proxy({} as any, {
        get: (target: any, prop: string) => {
            if (typeof prop !== 'string') return undefined;
            if (prop === 'then') return undefined;
            
            const fullName = `${namespacePrefix}.${prop}`;
            if (cache.has(fullName)) {
                return cache.get(fullName);
            }
            
            const result = dotnet._load(fullName);
            cache.set(fullName, result);
            return result;
        }
    });
}
