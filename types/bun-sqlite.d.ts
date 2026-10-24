// The slice of bun:sqlite that lib/t3-state.ts uses. @types/bun would also retype global fetch,
// which lib/linear.ts relies on, so this declares only the module.
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { readonly?: boolean; create?: boolean });
    query(sql: string): { all(...params: unknown[]): unknown[] };
    close(): void;
  }
}
