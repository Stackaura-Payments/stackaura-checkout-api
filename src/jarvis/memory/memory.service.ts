import { Injectable } from '@nestjs/common';

export interface JarvisMemoryEntry {
  key: string;
  value: unknown;
  createdAt: Date;
}

@Injectable()
export class MemoryService {
  private readonly memory = new Map<string, JarvisMemoryEntry>();

  set(key: string, value: unknown): void {
    this.memory.set(key, {
      key,
      value,
      createdAt: new Date(),
    });
  }

  get<T = unknown>(key: string): T | undefined {
    return this.memory.get(key)?.value as T | undefined;
  }

  list(): JarvisMemoryEntry[] {
    return Array.from(this.memory.values());
  }

  clear(): void {
    this.memory.clear();
  }
}
