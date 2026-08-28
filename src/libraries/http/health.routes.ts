import { Router } from 'express';
import { success } from './envelope.js';

export type DependencyCheck = {
  name: string;
  probe: () => Promise<string | undefined>;
};

// BullMQ requires its Redis client to be created with maxRetriesPerRequest: null, which means a
// command issued while the connection is down queues forever rather than failing. Without this
// bound the readiness probe hangs instead of reporting the outage it exists to report.
const PROBE_TIMEOUT_MS = 2000;

type CheckResult = {
  name: string;
  status: 'up' | 'down';
  duration_ms: number;
  detail?: string;
  error?: string;
};

export function createHealthRouter(checks: readonly DependencyCheck[], version: string): Router {
  const router = Router();

  // Liveness: answers as long as the process is running. Never touches a dependency, so a database
  // outage cannot make an orchestrator kill an otherwise healthy container.
  router.get('/health', (_req, res) => {
    res.json(
      success({
        status: 'ok',
        version,
        uptime_seconds: Math.round(process.uptime()),
      }),
    );
  });

  router.get('/health/ready', (_req, res, next) => {
    void (async () => {
      try {
        const results = await Promise.all(checks.map(runCheck));
        const ready = results.every((result) => result.status === 'up');

        res.status(ready ? 200 : 503).json(
          success({
            status: ready ? 'ready' : 'degraded',
            version,
            uptime_seconds: Math.round(process.uptime()),
            checks: results,
          }),
        );
      } catch (error) {
        next(error);
      }
    })();
  });

  return router;
}

async function runCheck({ name, probe }: DependencyCheck): Promise<CheckResult> {
  const startedAt = Date.now();
  try {
    const detail = await withTimeout(probe(), PROBE_TIMEOUT_MS);
    return {
      name,
      status: 'up',
      duration_ms: Date.now() - startedAt,
      ...(detail === undefined ? {} : { detail }),
    };
  } catch (error) {
    return {
      name,
      status: 'down',
      duration_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : 'probe failed',
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`probe did not answer within ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, expiry]).finally(() => {
    clearTimeout(timer);
  });
}
