/**
 * Unit tests for drizzle/db.ts — pool initialization retry logic.
 *
 * pg.Pool is mocked BEFORE the module is imported so that the module-load
 * auto-invoke does not fire real connection attempts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted variables — vi.hoisted() ensures these are available inside
// vi.mock() factory functions even though vi.mock() calls are hoisted.
// ---------------------------------------------------------------------------

const { mockConnect, mockRelease, mockPoolOn, mockPoolEnd, mockLogger } = vi.hoisted(() => {
  const mockRelease = vi.fn();
  // Default: connect resolves immediately so the module-load auto-invoke succeeds
  // and does not leave pending promises that interact with fake timers in tests.
  const mockConnect = vi.fn().mockResolvedValue({ release: vi.fn() });
  const mockPoolOn = vi.fn();
  const mockPoolEnd = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { mockConnect, mockRelease, mockPoolOn, mockPoolEnd, mockLogger };
});

// ---------------------------------------------------------------------------
// Mocks — all vi.mock() calls are hoisted by vitest to the top of the file.
// ---------------------------------------------------------------------------

vi.mock('pg', () => {
  function MockPool() {
    return {
      connect: mockConnect,
      on: mockPoolOn,
      end: mockPoolEnd,
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
    };
  }
  return { default: { Pool: MockPool } };
});

vi.mock('@sprqvntrs/logger/server', () => ({
  createServerLogger: vi.fn(() => ({ logger: mockLogger })),
}));

vi.mock('#config', () => ({
  CONFIG: {
    database: {
      url: 'postgres://test:test@localhost:5432/test',
      ssl: false,
      pool: {
        max: 10,
        min: 2,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      },
    },
    app: {
      isProduction: false,
      isDevelopment: true,
      nodeEnv: 'test',
    },
  },
}));

vi.mock('dotenv/config', () => ({}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks are registered
// ---------------------------------------------------------------------------
import { initializePool } from './db';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('initializePool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Default: connect succeeds immediately
    mockConnect.mockResolvedValue({ release: mockRelease });
    // Prevent process.exit(1) from the module-load .catch() from killing the
    // test process or generating unhandled rejections via vitest's exit guard.
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves on first attempt when connect succeeds', async () => {
    await expect(initializePool(3)).resolves.toBeUndefined();
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('retries on transient failure and resolves when connect succeeds on second attempt', async () => {
    const transientError = new Error('ECONNREFUSED');
    mockConnect
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce({ release: mockRelease });

    const promise = initializePool(3);

    // Drain the first failed attempt then advance timers past the retry delay
    await vi.advanceTimersByTimeAsync(5000);

    await expect(promise).resolves.toBeUndefined();

    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('attempt 1/3'),
      expect.objectContaining({ error: transientError.message }),
    );
  });

  it('throws after exhausting all attempts and logs warn between retries', async () => {
    const persistentError = new Error('postgres unavailable');
    mockConnect.mockRejectedValue(persistentError);

    const promise = initializePool(2);
    // Attach a no-op catch immediately to prevent unhandled-rejection warnings
    // while the promise is still pending during timer advancement.
    promise.catch(() => undefined);

    // Advance time past all retry delays (2 attempts = 1 retry wait)
    await vi.advanceTimersByTimeAsync(10000);

    await expect(promise).rejects.toThrow('postgres unavailable');

    // warn is called once — between attempt 1 and attempt 2
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });
});
