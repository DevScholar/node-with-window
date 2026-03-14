import { IpcSync } from './ipc.js';
import * as cp from 'node:child_process';

let _ipc: IpcSync | null = null;
let _proc: cp.ChildProcess | null = null;
let _initialized = false;
let _cachedRuntimeInfo: { frameworkMoniker: string; runtimeVersion: string } | null = null;

export function getIpc() { return _ipc; }
export function getProc() { return _proc; }
export function getInitialized() { return _initialized; }
export function getCachedRuntimeInfo() { return _cachedRuntimeInfo; }

export function setIpc(val: IpcSync | null) { _ipc = val; }
export function setProc(val: cp.ChildProcess | null) { _proc = val; }
export function setInitialized(val: boolean) { _initialized = val; }
export function setCachedRuntimeInfo(val: { frameworkMoniker: string; runtimeVersion: string } | null) { _cachedRuntimeInfo = val; }
