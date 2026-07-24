import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicComponentTracker } from "../../src/shared/discord/components.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("public command controls", () => {
  it("allows only the caller while the message is tracked", () => {
    const tracker = new PublicComponentTracker();
    tracker.track("message-1", "caller-1", async () => {});

    expect(tracker.access("message-1", "caller-1")).toBe("allowed");
    expect(tracker.access("message-1", "someone-else")).toBe("not-owner");
    expect(tracker.access("unknown-message", "caller-1")).toBe("expired");
  });

  it("expires and disables tracked controls after the lifetime", async () => {
    vi.useFakeTimers();
    const onExpire = vi.fn(async () => {});
    const tracker = new PublicComponentTracker(1_000);
    tracker.track("message-1", "caller-1", onExpire);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(tracker.access("message-1", "caller-1")).toBe("expired");
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("keeps controls alive while the caller is using them", async () => {
    vi.useFakeTimers();
    const onExpire = vi.fn(async () => {});
    const tracker = new PublicComponentTracker(1_000);
    tracker.track("message-1", "caller-1", onExpire);

    await vi.advanceTimersByTimeAsync(750);
    expect(tracker.access("message-1", "caller-1")).toBe("allowed");
    await vi.advanceTimersByTimeAsync(750);

    expect(tracker.access("message-1", "caller-1")).toBe("allowed");
    expect(onExpire).not.toHaveBeenCalled();
  });
});
