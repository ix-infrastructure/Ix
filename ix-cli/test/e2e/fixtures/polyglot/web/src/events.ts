import type { Listener } from "./types";

const listeners: Listener[] = [];

export function on(listener: Listener): void {
  listeners.push(listener);
}

export function emit(event: string, payload: unknown): number {
  for (const listener of listeners) listener(event, payload);
  return listeners.length;
}
