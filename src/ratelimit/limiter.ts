import { MiddlewareHandler } from "hono";
import { WORLD } from "../../world.config";
import { AppEnv } from "../types";

interface BucketSpec {
  name: string;
  limit: number;
  periodSec: number;
}

interface CheckRequest {
  buckets: BucketSpec[];
}

interface CheckResponse {
  ok: boolean;
  retry_after?: number;
  bucket?: string;
}

/**
 * Fixed-window counters in Durable Object storage. One DO instance per
 * subject (API key hash or client IP), so contention is naturally sharded.
 */
export class RateLimiterDO implements DurableObject {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const { buckets } = (await request.json()) as CheckRequest;
    const nowSec = Math.floor(Date.now() / 1000);

    // One storage entry per bucket name; stale windows reset in place, so
    // storage never accumulates old keys.
    const windows = new Map<string, { windowStart: number; count: number }>();
    for (const b of buckets) {
      const windowStart = nowSec - (nowSec % b.periodSec);
      const stored = await this.state.storage.get<{ windowStart: number; count: number }>(b.name);
      const w = stored && stored.windowStart === windowStart ? stored : { windowStart, count: 0 };
      if (w.count >= b.limit) {
        const res: CheckResponse = { ok: false, retry_after: windowStart + b.periodSec - nowSec, bucket: b.name };
        return Response.json(res);
      }
      windows.set(b.name, w);
    }
    for (const [name, w] of windows) {
      await this.state.storage.put(name, { windowStart: w.windowStart, count: w.count + 1 });
    }
    return Response.json({ ok: true } satisfies CheckResponse);
  }
}

export async function checkRateLimit(
  ns: DurableObjectNamespace,
  subject: string,
  buckets: BucketSpec[],
): Promise<CheckResponse> {
  const stub = ns.get(ns.idFromName(subject));
  const res = await stub.fetch("https://ratelimit/check", {
    method: "POST",
    body: JSON.stringify({ buckets } satisfies CheckRequest),
  });
  return (await res.json()) as CheckResponse;
}

function tooMany(retryAfter: number, bucket: string) {
  return Response.json(
    { error: "rate limited", bucket, retry_after: retryAfter },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

/** Per-key request throttle applied to every authenticated request. */
export const perKeyLimiter: MiddlewareHandler<AppEnv> = async (c, next) => {
  const agent = c.get("agent");
  if (agent) {
    const isWrite = c.req.method !== "GET" && c.req.method !== "HEAD";
    const buckets: BucketSpec[] = [
      { name: "rpm", limit: WORLD.limits.requestsPerMinute, periodSec: 60 },
    ];
    if (isWrite) buckets.push({ name: "wpd", limit: WORLD.limits.writesPerDay, periodSec: 86_400 });
    const res = await checkRateLimit(c.env.RATE_LIMITER, `key:${agent.id}`, buckets);
    if (!res.ok) return tooMany(res.retry_after ?? 60, res.bucket ?? "rpm");
  }
  await next();
};

/** Extra daily cap for artifact creation. */
export const artifactCreateLimiter: MiddlewareHandler<AppEnv> = async (c, next) => {
  const agent = c.get("agent");
  if (agent) {
    const res = await checkRateLimit(c.env.RATE_LIMITER, `key:${agent.id}`, [
      { name: "apd", limit: WORLD.limits.artifactsPerDay, periodSec: 86_400 },
    ]);
    if (!res.ok) return tooMany(res.retry_after ?? 3600, res.bucket ?? "apd");
  }
  await next();
};

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

/** Per-IP registration limit (agents have no key yet when they register). */
export async function checkRegistrationLimit(
  ns: DurableObjectNamespace,
  ip: string,
): Promise<CheckResponse> {
  return checkRateLimit(ns, `ip:${ip}`, [
    { name: "reg", limit: WORLD.limits.registrationsPerIpPerDay, periodSec: 86_400 },
  ]);
}
