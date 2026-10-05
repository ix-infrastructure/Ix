import { emit } from "./events";

export class Store<T> {
  private readonly items = new Map<string, T>();

  get(key: string): T | undefined {
    return this.items.get(key);
  }

  set(key: string, value: T): void {
    this.items.set(key, value);
    emit("store.set", key);
  }
}
