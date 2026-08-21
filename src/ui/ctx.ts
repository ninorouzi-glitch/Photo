import type { Store } from '../state/store.ts';

export type Ctx = {
  store: Store;
  go(stage: number): void;
  rerender(): void;
  live(message: string): void;
};
