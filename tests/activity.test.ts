/**
 * Tests for src/activity.ts — the task registry behind the Activity screen.
 *
 * The screen's whole job is to be honest about what the app is doing, so these pin the
 * things a user would notice if they were wrong: the bar reflecting weighted work rather
 * than step count, finished tasks settling at 100%, and cancel/dismiss meaning different
 * things depending on whether the task is still running.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  startTask,
  advanceTask,
  finishTask,
  failTask,
  cancelTask,
  isCancelled,
  dismissTask,
  listTasks,
  resetTasks,
  TAILOR_STEPS,
} from "../src/activity.js";

beforeEach(() => resetTasks());

describe("task lifecycle", () => {
  it("starts a task running at zero progress", () => {
    const t = startTask("tailor", "Senior .NET Developer", "Acme Ltd", TAILOR_STEPS);
    expect(t.state).toBe("running");
    expect(t.progress).toBe(0);
    expect(t.finishedAt).toBeNull();
    expect(listTasks()).toHaveLength(1);
  });

  it("finishes at 100% with a terminal state", () => {
    const t = startTask("tailor", "Job", "Co", TAILOR_STEPS);
    finishTask(t.id, "done + .docx");
    const [got] = listTasks();
    expect(got!.state).toBe("done");
    expect(got!.progress).toBe(1);
    expect(got!.finishedAt).not.toBeNull();
    expect(got!.message).toBe("done + .docx");
  });

  it("records a failure without pretending it completed", () => {
    const t = startTask("tailor", "Job", "Co", TAILOR_STEPS);
    advanceTask(t.id, 2);
    failTask(t.id, "Ollama returned empty content");
    const [got] = listTasks();
    expect(got!.state).toBe("error");
    expect(got!.error).toBe("Ollama returned empty content");
    // Progress must NOT jump to 100 on failure — it stopped where it stopped.
    expect(got!.progress).toBeLessThan(1);
  });
});

describe("weighted progress", () => {
  it("weights the two model-written documents above the fast steps", () => {
    const t = startTask("tailor", "Job", "Co", TAILOR_STEPS);
    // After the two cheap steps (weight 1 + 1 of 13) the bar should still be low — an
    // unweighted 2-of-5 bar would claim 40%.
    advanceTask(t.id, 2);
    const afterCheapSteps = listTasks()[0]!.progress;
    expect(afterCheapSteps).toBeLessThan(0.2);

    // After the summary (weight 4) it should have moved substantially.
    advanceTask(t.id, 3);
    expect(listTasks()[0]!.progress).toBeGreaterThan(afterCheapSteps);
    expect(listTasks()[0]!.progress).toBeLessThan(1);
  });

  it("never exceeds 1 even if advanced past the last step", () => {
    const t = startTask("tailor", "Job", "Co", TAILOR_STEPS);
    advanceTask(t.id, 99);
    expect(listTasks()[0]!.progress).toBe(1);
  });

  it("ignores updates to an already-finished task", () => {
    const t = startTask("tailor", "Job", "Co", TAILOR_STEPS);
    finishTask(t.id, "done");
    advanceTask(t.id, 1);
    expect(listTasks()[0]!.progress).toBe(1);
    expect(listTasks()[0]!.state).toBe("done");
  });
});

describe("cancel and dismiss", () => {
  it("cancel on a running task is cooperative, not immediate", () => {
    const t = startTask("tailor", "Job", "Co", TAILOR_STEPS);
    expect(isCancelled(t.id)).toBe(false);
    expect(cancelTask(t.id)).toBe(true);
    expect(isCancelled(t.id)).toBe(true);
    // Still listed — the work has to notice the flag and stop of its own accord.
    expect(listTasks()).toHaveLength(1);
    expect(listTasks()[0]!.state).toBe("cancelled");
  });

  it("cancel on a finished task removes it from the list", () => {
    const t = startTask("tailor", "Job", "Co", TAILOR_STEPS);
    finishTask(t.id, "done");
    expect(cancelTask(t.id)).toBe(true);
    expect(listTasks()).toHaveLength(0);
  });

  it("dismiss refuses to hide work that is still running", () => {
    const t = startTask("tailor", "Job", "Co", TAILOR_STEPS);
    expect(dismissTask(t.id)).toBe(false);
    expect(listTasks()).toHaveLength(1);
  });

  it("dismiss removes a finished task", () => {
    const t = startTask("tailor", "Job", "Co", TAILOR_STEPS);
    failTask(t.id, "boom");
    expect(dismissTask(t.id)).toBe(true);
    expect(listTasks()).toHaveLength(0);
  });

  it("cancel and dismiss on an unknown id are safe no-ops", () => {
    expect(cancelTask("nope")).toBe(false);
    expect(dismissTask("nope")).toBe(false);
    expect(isCancelled("nope")).toBe(false);
  });
});

describe("listTasks", () => {
  it("returns newest first", () => {
    const a = startTask("tailor", "First", "Co", TAILOR_STEPS);
    const b = startTask("tailor", "Second", "Co", TAILOR_STEPS);
    const ids = listTasks().map((t) => t.id);
    expect(ids[0]).toBe(b.id);
    expect(ids[1]).toBe(a.id);
  });

  it("hands back copies, so a caller cannot mutate the registry", () => {
    const t = startTask("tailor", "Job", "Co", TAILOR_STEPS);
    listTasks()[0]!.progress = 0.99;
    expect(listTasks()[0]!.progress).toBe(0);
    expect(t.id).toBeTruthy();
  });

  it("keeps running tasks when pruning old finished ones", () => {
    const live = startTask("tailor", "Live", "Co", TAILOR_STEPS);
    for (let i = 0; i < 60; i++) finishTask(startTask("tailor", `Old ${i}`, "Co", TAILOR_STEPS).id, "done");
    const ids = listTasks().map((t) => t.id);
    expect(ids).toContain(live.id);
    expect(listTasks().length).toBeLessThanOrEqual(51);
  });
});
