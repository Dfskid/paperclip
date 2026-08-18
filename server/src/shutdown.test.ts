import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  beginHttpServerShutdown,
  closeHttpServerForShutdown,
  coalesceShutdown,
  coordinateHeartbeatSchedulerShutdown,
  drainExecutionOwnershipForShutdown,
  loadWithoutCoordinatedShutdownSignalHooks,
  runShutdownAndExit,
} from "./shutdown.js";

describe("coalesceShutdown", () => {
  it("returns one in-flight shutdown when different signals arrive together", async () => {
    let releaseShutdown!: () => void;
    const shutdownBlocked = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    const performShutdown = vi.fn(async (_signal: "SIGINT" | "SIGTERM") => {
      await shutdownBlocked;
    });
    const shutdown = coalesceShutdown(performShutdown);

    const first = shutdown("SIGINT");
    const second = shutdown("SIGTERM");

    expect(second).toBe(first);
    expect(performShutdown).toHaveBeenCalledOnce();
    expect(performShutdown).toHaveBeenCalledWith("SIGINT");

    releaseShutdown();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });
});

describe("closeHttpServerForShutdown", () => {
  it("awaits and propagates an HTTP listener close failure", async () => {
    const closeError = new Error("listener close failed");
    let reportClose!: (error?: Error) => void;
    const closeIdleConnections = vi.fn();
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => {
        reportClose = callback;
      }),
      closeIdleConnections,
    };

    let settled = false;
    const closing = closeHttpServerForShutdown(server).finally(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(server.close).toHaveBeenCalledOnce();
    expect(closeIdleConnections).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    reportClose(closeError);
    await expect(closing).rejects.toBe(closeError);
  });
});

describe("beginHttpServerShutdown", () => {
  it("starts listener close without blocking execution drain on an active response", async () => {
    let reportClose!: (error?: Error) => void;
    const closeAllConnections = vi.fn(() => reportClose());
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => {
        reportClose = callback;
      }),
      closeIdleConnections: vi.fn(),
      closeAllConnections,
    };

    const shutdown = beginHttpServerShutdown(server);

    expect(server.close).toHaveBeenCalledOnce();
    expect(server.closeIdleConnections).toHaveBeenCalledOnce();
    expect(closeAllConnections).not.toHaveBeenCalled();

    shutdown.closeRemainingConnections();
    await expect(shutdown.waitForClose()).resolves.toBeUndefined();
    expect(closeAllConnections).toHaveBeenCalledOnce();
  });

  it("captures an early close failure until the ordered waiter observes it", async () => {
    const closeError = new Error("listener close failed before drain");
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => callback(closeError)),
    };

    const shutdown = beginHttpServerShutdown(server);
    await Promise.resolve();

    await expect(shutdown.waitForClose()).rejects.toBe(closeError);
  });
});

describe("loadWithoutCoordinatedShutdownSignalHooks", () => {
  it("removes the eager signal handlers from the real embedded-postgres import", async () => {
    const before = {
      SIGINT: process.rawListeners("SIGINT"),
      SIGTERM: process.rawListeners("SIGTERM"),
    };
    const moduleName = "embedded-postgres";

    await loadWithoutCoordinatedShutdownSignalHooks(() => import(moduleName));

    expect(process.rawListeners("SIGINT")).toEqual(before.SIGINT);
    expect(process.rawListeners("SIGTERM")).toEqual(before.SIGTERM);
  });

  it("keeps the database available for a marker-backed SIGTERM snapshot", async () => {
    const signalTarget = new EventEmitter();
    const preexistingSignalListener = vi.fn();
    signalTarget.on("SIGTERM", preexistingSignalListener);

    let databaseAvailable = true;
    const embeddedPostgresExitHook = vi.fn(() => {
      databaseAvailable = false;
    });
    await loadWithoutCoordinatedShutdownSignalHooks(
      async () => {
        signalTarget.on("SIGINT", embeddedPostgresExitHook);
        signalTarget.on("SIGTERM", embeddedPostgresExitHook);
        return { default: class EmbeddedPostgres {} };
      },
      signalTarget,
    );

    let shutdown: Promise<unknown> | null = null;
    let snapshotCaptured = false;
    signalTarget.once("SIGTERM", () => {
      shutdown = coordinateHeartbeatSchedulerShutdown({
        signal: "SIGTERM",
        prepareHotRestartShutdown: async () => {
          // This models the real failure path: a valid intent exists, and the
          // snapshot must query embedded PostgreSQL after SIGTERM is delivered.
          expect(databaseAvailable).toBe(true);
          snapshotCaptured = true;
          return { mode: "hot_restart" as const, skipDrain: true };
        },
        waitForHeartbeatSchedulerIdle: vi.fn(async () => undefined),
      });
    });

    signalTarget.emit("SIGTERM");
    await shutdown;

    expect(preexistingSignalListener).toHaveBeenCalledOnce();
    expect(embeddedPostgresExitHook).not.toHaveBeenCalled();
    expect(snapshotCaptured).toBe(true);
  });
});

describe("coordinateHeartbeatSchedulerShutdown", () => {
  it("quiesces active scheduler work before capturing a hot-restart snapshot", async () => {
    let snapshotCaptured = false;
    let releaseScheduler!: () => void;
    const schedulerIdle = new Promise<void>((resolve) => {
      releaseScheduler = resolve;
    });
    const waitForHeartbeatSchedulerIdle = vi.fn(() => schedulerIdle);

    const shutdown = coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => {
        snapshotCaptured = true;
        return { mode: "prepared" as const, skipDrain: true };
      }),
      waitForHeartbeatSchedulerIdle,
    });

    await vi.waitFor(() => expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce());
    expect(snapshotCaptured).toBe(false);
    releaseScheduler();

    const result = await shutdown;
    expect(snapshotCaptured).toBe(true);
    expect(result).toEqual({
      hotRestart: { mode: "prepared", skipDrain: true },
      preparationError: null,
      waitedForSchedulerIdle: true,
    });
  });

  it("quiesces scheduler work before selecting server-stdio runs to drain", async () => {
    const waitForHeartbeatSchedulerIdle = vi.fn(async () => undefined);

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => ({
        mode: "acp_drain_required" as const,
        skipDrain: false,
        drainRunIds: ["acp-run"],
      })),
      waitForHeartbeatSchedulerIdle,
    });

    expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce();
    expect(result).toEqual({
      hotRestart: {
        mode: "acp_drain_required",
        skipDrain: false,
        drainRunIds: ["acp-run"],
      },
      preparationError: null,
      waitedForSchedulerIdle: true,
    });
  });

  it("preserves the scheduler idle wait for normal graceful shutdown", async () => {
    let releaseScheduler!: () => void;
    const schedulerIdle = new Promise<void>((resolve) => {
      releaseScheduler = resolve;
    });
    const waitForHeartbeatSchedulerIdle = vi.fn(() => schedulerIdle);
    let settled = false;

    const shutdown = coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => ({
        mode: "not_requested" as const,
        skipDrain: false,
      })),
      waitForHeartbeatSchedulerIdle,
    }).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce());
    expect(settled).toBe(false);

    releaseScheduler();

    await expect(shutdown).resolves.toEqual({
      hotRestart: { mode: "not_requested", skipDrain: false },
      preparationError: null,
      waitedForSchedulerIdle: true,
    });
  });

  it("waits for scheduler idle when hot-restart preparation is unavailable", async () => {
    const waitForHeartbeatSchedulerIdle = vi.fn(async () => undefined);

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: null,
      waitForHeartbeatSchedulerIdle,
    });

    expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce();
    expect(result).toEqual({
      hotRestart: null,
      preparationError: null,
      waitedForSchedulerIdle: true,
    });
  });

  it("falls back to the scheduler idle wait when hot-restart preparation fails", async () => {
    const preparationError = new Error("snapshot failed");
    const waitForHeartbeatSchedulerIdle = vi.fn(async () => undefined);

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => {
        throw preparationError;
      }),
      waitForHeartbeatSchedulerIdle,
    });

    expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce();
    expect(result).toEqual({
      hotRestart: null,
      preparationError,
      waitedForSchedulerIdle: true,
    });
  });
});

describe("drainExecutionOwnershipForShutdown", () => {
  it("always closes retained runtimes after a heartbeat drain failure", async () => {
    const drainError = new Error("heartbeat drain failed");
    const closeRetainedRuntimes = vi.fn(async () => ({ closedWarmHandles: 1 }));

    await expect(drainExecutionOwnershipForShutdown({
      drainHeartbeatRuns: async () => {
        throw drainError;
      },
      closeRetainedRuntimes,
    })).rejects.toBe(drainError);

    expect(closeRetainedRuntimes).toHaveBeenCalledOnce();
  });

  it("retries retained runtime closure before failing shutdown", async () => {
    const closeError = new Error("runtime close failed");
    const closeRetainedRuntimes = vi
      .fn()
      .mockRejectedValueOnce(closeError)
      .mockResolvedValueOnce({ closedWarmHandles: 1 });

    await expect(drainExecutionOwnershipForShutdown({
      drainHeartbeatRuns: async () => ({ interrupted: 0 }),
      closeRetainedRuntimes,
      retainedRuntimeCloseAttempts: 2,
    })).resolves.toEqual({
      drain: { interrupted: 0 },
      retainedRuntimes: { closedWarmHandles: 1 },
    });
    expect(closeRetainedRuntimes).toHaveBeenCalledTimes(2);
  });

  it("fails closed when retained runtime closure remains unsuccessful", async () => {
    const closeError = new Error("runtime close failed");
    const closeRetainedRuntimes = vi.fn().mockRejectedValue(closeError);

    await expect(drainExecutionOwnershipForShutdown({
      drainHeartbeatRuns: async () => null,
      closeRetainedRuntimes,
      retainedRuntimeCloseAttempts: 3,
    })).rejects.toBe(closeError);
    expect(closeRetainedRuntimes).toHaveBeenCalledTimes(3);
  });
});

describe("runShutdownAndExit", () => {
  it("exits non-zero when work after the HTTP close fails", async () => {
    const events: string[] = [];
    const error = new Error("post-listener shutdown failed");

    await runShutdownAndExit({
      shutdown: async () => {
        events.push("http_closed");
        throw error;
      },
      onFailure: (caught) => {
        expect(caught).toBe(error);
        events.push("failure_recorded");
      },
      exit: (code) => {
        events.push(`exit_${code}`);
      },
    });

    expect(events).toEqual(["http_closed", "failure_recorded", "exit_1"]);
  });

  it("exits zero only after all shutdown work succeeds", async () => {
    const events: string[] = [];

    await runShutdownAndExit({
      shutdown: async () => {
        events.push("http_closed");
        events.push("drained");
      },
      onFailure: () => {
        events.push("unexpected_failure");
      },
      exit: (code) => {
        events.push(`exit_${code}`);
      },
    });

    expect(events).toEqual(["http_closed", "drained", "exit_0"]);
  });
});
