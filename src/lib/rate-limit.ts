type AttemptState = {
  failures: number;
  windowStartedAt: number;
  lockedUntil: number;
};

const attempts = new Map<string, AttemptState>();
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const MAX_ENTRIES = 10_000;

function prune(now: number): void {
  if (attempts.size < MAX_ENTRIES) return;

  for (const [key, state] of attempts) {
    if (state.lockedUntil < now && now - state.windowStartedAt > WINDOW_MS) {
      attempts.delete(key);
    }
  }
}

export function loginKey(email: string): string {
  return email.trim().toLowerCase();
}

export function checkLoginAllowed(key: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  prune(now);

  const state = attempts.get(key);
  if (!state) return { allowed: true, retryAfterSeconds: 0 };

  if (state.lockedUntil > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((state.lockedUntil - now) / 1000),
    };
  }

  if (now - state.windowStartedAt > WINDOW_MS) {
    attempts.delete(key);
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

export function recordLoginFailure(key: string): { locked: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const state = attempts.get(key);

  if (!state || now - state.windowStartedAt > WINDOW_MS) {
    attempts.set(key, { failures: 1, windowStartedAt: now, lockedUntil: 0 });
    return { locked: false, retryAfterSeconds: 0 };
  }

  state.failures += 1;

  if (state.failures >= MAX_FAILURES) {
    state.lockedUntil = now + LOCK_MS;
    state.failures = 0;
    state.windowStartedAt = now;
    return { locked: true, retryAfterSeconds: Math.ceil(LOCK_MS / 1000) };
  }

  return { locked: false, retryAfterSeconds: 0 };
}

export function clearLoginFailures(key: string): void {
  attempts.delete(key);
}
