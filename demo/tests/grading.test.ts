import { describe, expect, it } from "vitest";
import { defaultQuestions, passed, questionsForTrack, scoreAnswers, snapshotQuestion, type AnswerRecord } from "../domain/questions.js";

function answered(overrides: Partial<AnswerRecord>): AnswerRecord {
  return { questionId: "q", prompt: "p", kind: "CHOICE", style: null, imageUrl: null, text: null, options: [], chosenIndex: null, correct: null, ...overrides };
}

describe("questionnaire grading", () => {
  it("scores only CHOICE answers", () => {
    const answers = [
      answered({ kind: "TEXT", text: "hi" }),
      answered({ correct: true }),
      answered({ correct: false }),
      answered({ correct: true }),
    ];
    expect(scoreAnswers(answers)).toEqual({ correct: 2, total: 3 });
  });

  it("passed() honours the configured bar", () => {
    expect(passed({ correct: 2, total: 3 }, 0)).toBe(true); // 0 disables the bar
    expect(passed({ correct: 2, total: 3 }, 3)).toBe(false);
    expect(passed({ correct: 3, total: 3 }, 3)).toBe(true);
  });

  it("only serves active questions for the track, in order", () => {
    const all = defaultQuestions();
    const surfer = questionsForTrack(all, "SURFER");
    expect(surfer.length).toBeGreaterThan(0);
    expect(surfer.every((q) => q.track === "SURFER" || q.track === "BOTH")).toBe(true);
    expect(surfer.some((q) => q.track === "ENGINEER")).toBe(false);
    const orders = surfer.map((q) => q.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it("snapshotting a CHOICE question copies its options and starts unanswered", () => {
    const choice = defaultQuestions().find((q) => q.kind === "CHOICE");
    expect(choice).toBeDefined();
    const snap = snapshotQuestion(choice!);
    expect(snap.options?.length).toBe(choice!.options?.length);
    expect(snap.chosenIndex).toBeNull();
    expect(snap.correct).toBeNull();
    // Snapshot is a copy: mutating the source options must not affect it.
    choice!.options![0]!.label = "MUTATED";
    expect(snap.options![0]!.label).not.toBe("MUTATED");
  });
});
