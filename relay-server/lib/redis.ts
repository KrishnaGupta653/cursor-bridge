import { Redis } from "@upstash/redis";
import {
  RelayMessage,
  Session,
  DeviceType,
  REDIS_KEYS,
  TTL,
  CommandEvent,
} from "./types.js";

// Upstash Redis 클라이언트 (lazy initialization)
let _redis: Redis | null = null;

function getRedis(): Redis {
  if (!_redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
      const errorMsg = `Redis not configured: URL=${!!url}, Token=${!!token}. Please set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN environment variables.`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    try {
      _redis = new Redis({ url, token });
    } catch (error) {
      console.error("Failed to initialize Redis client:", error);
      throw new Error(
        `Failed to initialize Redis: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }
  return _redis;
}

// Commands issued in the same tick share one HTTP round trip (Upstash auto-pipelining),
// so independent reads/writes below are started together with Promise.all.

/** Phones poll at least every 10 s while open; one silent for longer is no longer delivered to. */
export const MOBILE_STALE_MS = 2 * 60 * 1000;
const MAX_QUEUE_LENGTH = 1000;

/** Session JSON as stored. Records written before phones moved to their own set may still carry them. */
type StoredSession = Session & { pcPinHash?: string };

function parse<T>(data: unknown): T | null {
  if (data == null) return null;
  return (typeof data === "string" ? JSON.parse(data) : data) as T;
}

// 세션 생성 (expiresAt: the credential's absolute expiry; the record never outlives it)
export async function createSession(sessionId: string, expiresAt: number): Promise<Session> {
  const session: Session = { sessionId, createdAt: Date.now(), expiresAt };
  await getRedis().set(REDIS_KEYS.session(sessionId), JSON.stringify(session), { pxat: expiresAt });
  return session;
}

/** The stored record only (no phone/last-seen lookups). */
export async function getSessionRecord(sessionId: string): Promise<StoredSession | null> {
  return parse<StoredSession>(await getRedis().get(REDIS_KEYS.session(sessionId)));
}

// 세션 조회: record + phones that polled recently + the Mac's last-seen time
export async function getSession(sessionId: string): Promise<Session | null> {
  const redis = getRedis();
  const [raw, live, pcSeen] = await Promise.all([
    redis.get(REDIS_KEYS.session(sessionId)),
    redis.zrange<unknown[]>(REDIS_KEYS.sessionMobiles(sessionId), Date.now() - MOBILE_STALE_MS, "+inf", { byScore: true }),
    redis.get(REDIS_KEYS.pcLastSeen(sessionId)),
  ]);
  const stored = parse<StoredSession>(raw);
  if (!stored) return null;
  const mobiles = new Set([...(stored.mobileDeviceIds ?? []), ...(live ?? []).map(String)]);
  const pcLastSeenAt = Math.max(Number(pcSeen) || 0, stored.pcLastSeenAt ?? 0);
  return {
    sessionId: stored.sessionId,
    pcDeviceId: stored.pcDeviceId,
    ...(pcLastSeenAt ? { pcLastSeenAt } : {}),
    mobileDeviceIds: [...mobiles],
    createdAt: stored.createdAt,
    expiresAt: stored.expiresAt,
  };
}

/** Records that [deviceId] is alive. Called on every poll; expires with the session. */
export function markSeen(
  sessionId: string,
  deviceId: string,
  deviceType: DeviceType,
  expiresAt: number
): Promise<unknown> {
  const redis = getRedis();
  const now = Date.now();
  if (deviceType === "pc") {
    return redis.set(REDIS_KEYS.pcLastSeen(sessionId), now, { pxat: expiresAt });
  }
  const key = REDIS_KEYS.sessionMobiles(sessionId);
  return Promise.all([
    redis.zadd(key, { score: now, member: deviceId }),
    redis.pexpireat(key, expiresAt),
  ]);
}

/** Heartbeat: the caller has checked that [sessionId]'s record names this Mac. */
export async function updatePcLastSeen(sessionId: string, expiresAt: number): Promise<void> {
  await markSeen(sessionId, "", "pc", expiresAt);
}

// 세션에 디바이스 연결
export async function joinSession(
  sessionId: string,
  deviceId: string,
  deviceType: DeviceType
): Promise<Session | null> {
  const stored = await getSessionRecord(sessionId);
  if (!stored) return null;
  const writes: Promise<unknown>[] = [markSeen(sessionId, deviceId, deviceType, stored.expiresAt)];
  if (deviceType === "pc" && stored.pcDeviceId !== deviceId) {
    writes.push(getRedis().set(REDIS_KEYS.session(sessionId),
      JSON.stringify({ ...stored, pcDeviceId: deviceId }), { pxat: stored.expiresAt }));
  }
  await Promise.all(writes);
  return getSession(sessionId);
}

// 세션에서 모바일 디바이스 연결 해제
export async function leaveSession(sessionId: string, deviceId: string): Promise<void> {
  const redis = getRedis();
  const [stored] = await Promise.all([
    getSessionRecord(sessionId),
    redis.zrem(REDIS_KEYS.sessionMobiles(sessionId), deviceId),
    redis.del(REDIS_KEYS.messagesForDevice(sessionId, deviceId)),
  ]);
  if (stored?.mobileDeviceIds?.includes(deviceId)) {
    const mobileDeviceIds = stored.mobileDeviceIds.filter((id) => id !== deviceId);
    await redis.set(REDIS_KEYS.session(sessionId), JSON.stringify({ ...stored, mobileDeviceIds }), { keepTtl: true });
  }
}

/**
 * 메시지 전송 (큐에 추가). PC → Mobile goes only to [recipients] (the target phone, or every
 * live phone for a broadcast); phones that stopped polling are pruned from the session.
 */
export async function sendMessage(
  sessionId: string,
  message: RelayMessage,
  recipients: string[] = []
): Promise<void> {
  const redis = getRedis();
  const payload = JSON.stringify(message);
  const toMobile = message.to === "mobile";
  const queues = toMobile
    ? recipients.map((deviceId) => REDIS_KEYS.messagesForDevice(sessionId, deviceId))
    : [REDIS_KEYS.messagesMobile2PC(sessionId)];
  await Promise.all([
    ...queues.flatMap((queueKey) => [
      redis.lpush(queueKey, payload),
      redis.ltrim(queueKey, 0, MAX_QUEUE_LENGTH - 1),
      redis.expire(queueKey, TTL.message),
    ]),
    ...(toMobile
      ? [redis.zremrangebyscore(REDIS_KEYS.sessionMobiles(sessionId), "-inf", `(${Date.now() - MOBILE_STALE_MS}`)]
      : []),
  ]);
}

// 메시지 수신 (큐에서 가져오기): phones read their own queue, the Mac reads the session queue
export async function receiveMessages(
  sessionId: string,
  deviceType: DeviceType,
  limit: number = 10,
  deviceId?: string
): Promise<RelayMessage[]> {
  if (deviceType === "mobile" && !deviceId) return [];
  const queueKey = deviceType === "mobile"
    ? REDIS_KEYS.messagesForDevice(sessionId, deviceId!)
    : REDIS_KEYS.messagesMobile2PC(sessionId);

  // RPOP으로 오래된 메시지부터 가져오기 (one command for the whole batch)
  const batch = await getRedis().rpop<unknown[]>(queueKey, Math.max(1, limit));
  if (!Array.isArray(batch)) return [];
  return batch.map((data) => (typeof data === "string" ? JSON.parse(data) : data)) as RelayMessage[];
}

// 세션 삭제
export async function deleteSession(sessionId: string): Promise<void> {
  const redis = getRedis();
  const [stored, members] = await Promise.all([
    getSessionRecord(sessionId),
    redis.zrange<unknown[]>(REDIS_KEYS.sessionMobiles(sessionId), 0, -1),
  ]);
  const devices = new Set([...(stored?.mobileDeviceIds ?? []), ...(members ?? []).map(String)]);
  await redis.del(
    REDIS_KEYS.session(sessionId),
    REDIS_KEYS.sessionMobiles(sessionId),
    REDIS_KEYS.pcLastSeen(sessionId),
    REDIS_KEYS.messagesPC2Mobile(sessionId),
    REDIS_KEYS.messagesMobile2PC(sessionId),
    REDIS_KEYS.commandEvents(sessionId),
    ...[...devices].map((deviceId) => REDIS_KEYS.messagesForDevice(sessionId, deviceId))
  );
}

const MAX_COMMAND_EVENTS_PER_SESSION = 500;

export async function appendCommandEvent(
  sessionId: string,
  event: CommandEvent
): Promise<void> {
  const redis = getRedis();
  const key = REDIS_KEYS.commandEvents(sessionId);
  await Promise.all([
    redis.lpush(key, JSON.stringify(event)),
    redis.ltrim(key, 0, MAX_COMMAND_EVENTS_PER_SESSION - 1),
    redis.expire(key, TTL.session),
  ]);
}

/** Atomic security operations; never use destructive queue helpers for credentials. */
export async function securityOperation(action: string, key: string, value: unknown, ttl: number): Promise<any> {
  const redisKey = `security:v2:${key}`;
  const client = getRedis();
  if (action === "get") return client.get(redisKey);
  if (action === "put") return (await client.set(redisKey, value, { nx: true, ex: ttl })) === "OK";
  if (action === "delete") { await client.del(redisKey); return null; }
  if (action === "take") {
    const value = await client.eval<[], string | null>(
      "local v = redis.call('GET', KEYS[1]); redis.call('DEL', KEYS[1]); return v", [redisKey], []);
    return typeof value === "string" ? JSON.parse(value) : value;
  }
  if (action === "increment") return client.eval<[number], number>(
    "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return n",
    [redisKey], [ttl]);
  throw new Error("Unsupported security operation");
}
