import { securityOperation as redisOperation } from "./redis.js";
import { securityOperation as supabaseOperation } from "./supabase-store.js";

export type SecurityAction = "get" | "put" | "take" | "delete" | "increment";
export interface SecurityStore {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown, ttl: number): Promise<boolean>;
  take<T>(key: string): Promise<T | null>;
  delete(key: string): Promise<void>;
  increment(key: string, ttl: number): Promise<number>;
}
const operation = (action: SecurityAction, key: string, value: unknown = null, ttl = 86400) =>
  (process.env.SUPABASE_URL ? supabaseOperation : redisOperation)(action, key, value, ttl);
export const securityStore: SecurityStore = {
  get: key => operation("get", key),
  put: async (key, value, ttl) => (await operation("put", key, value, ttl)) === true,
  take: key => operation("take", key),
  delete: async key => { await operation("delete", key); },
  increment: async (key, ttl) => Number(await operation("increment", key, null, ttl)),
};
