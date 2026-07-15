// Pure questionnaire model: question shapes, default seed set, and grading.
// No I/O. The store persists these; the Discord layer renders them.

export type QuestionKind = "TEXT" | "CHOICE";
export type QuestionTrack = "SURFER" | "ENGINEER" | "BOTH";
export type TextStyle = "SHORT" | "PARAGRAPH";

export interface ChoiceOption {
  emoji: string;
  label: string;
  correct: boolean;
}

export interface Question {
  id: string;
  track: QuestionTrack;
  order: number;
  kind: QuestionKind;
  prompt: string;
  required: boolean;
  active: boolean;
  // TEXT only:
  style: TextStyle | null;
  // CHOICE only:
  imageUrl: string | null;
  options: ChoiceOption[] | null;
}

/**
 * A question snapshotted into an application together with the applicant's answer.
 * Carries everything needed to render the question, so editing the source question
 * mid-application never changes an in-progress thread or its grading.
 */
export interface AnswerRecord {
  questionId: string;
  prompt: string;
  kind: QuestionKind;
  style: TextStyle | null;
  imageUrl: string | null;
  // TEXT answer:
  text: string | null;
  // CHOICE answer:
  options: ChoiceOption[] | null;
  chosenIndex: number | null;
  correct: boolean | null;
}

export interface Score {
  correct: number;
  total: number;
}

export function applies(question: Question, track: "SURFER" | "ENGINEER"): boolean {
  return question.active && (question.track === track || question.track === "BOTH");
}

/** Active questions for a track, in display order. */
export function questionsForTrack(all: Question[], track: "SURFER" | "ENGINEER"): Question[] {
  return all.filter((q) => applies(q, track)).sort((a, b) => a.order - b.order);
}

/** Snapshot a question into a fresh, unanswered AnswerRecord. */
export function snapshotQuestion(question: Question): AnswerRecord {
  return {
    questionId: question.id,
    prompt: question.prompt,
    kind: question.kind,
    style: question.style,
    imageUrl: question.imageUrl,
    text: null,
    options: question.kind === "CHOICE" && question.options ? question.options.map((o) => ({ ...o })) : null,
    chosenIndex: null,
    correct: null,
  };
}

/** Practical (CHOICE) score across a set of answers. TEXT answers are not graded. */
export function scoreAnswers(answers: AnswerRecord[]): Score {
  const graded = answers.filter((a) => a.kind === "CHOICE");
  return { correct: graded.filter((a) => a.correct === true).length, total: graded.length };
}

export function passed(score: Score, passingScore: number): boolean {
  if (passingScore <= 0) return true;
  return score.correct >= passingScore;
}

let seedCounter = 0;
function seedId(prefix: string): string {
  seedCounter += 1;
  return `seed-${prefix}-${seedCounter}`;
}

function text(track: QuestionTrack, order: number, prompt: string, style: TextStyle): Question {
  return { id: seedId("t"), track, order, kind: "TEXT", prompt, required: true, active: true, style, imageUrl: null, options: null };
}

function choice(track: QuestionTrack, order: number, prompt: string, imageUrl: string | null, options: ChoiceOption[]): Question {
  return { id: seedId("c"), track, order, kind: "CHOICE", prompt, required: true, active: true, style: null, imageUrl, options };
}

/**
 * A sensible starter questionnaire, fully editable from Discord via /staff questions.
 * Image URLs are placeholders — replace them from the editor with real cabinet/cartop shots.
 */
export function defaultQuestions(): Question[] {
  seedCounter = 0;
  return [
    // Shared background (free text)
    text("BOTH", 1, "Confirm your Roblox username and your age range.", "SHORT"),
    text("BOTH", 2, "What is your timezone, and roughly how many hours per week can you be active?", "SHORT"),
    text("BOTH", 3, "Why do you want to join the lift staff team?", "PARAGRAPH"),

    // Surfer practical (cartop)
    choice(
      "SURFER",
      4,
      "You are riding the lift cartop and the cabin starts moving toward the top floor. What do you do first?",
      null,
      [
        { emoji: "🛑", label: "Hit the cartop stop switch", correct: true },
        { emoji: "🔼", label: "Ride it up faster", correct: false },
        { emoji: "🚪", label: "Open the car doors", correct: false },
      ],
    ),
    choice(
      "SURFER",
      5,
      "Which control keeps you safest while surfing the cartop between floors?",
      null,
      [
        { emoji: "🧯", label: "Inspection / slow-speed mode", correct: true },
        { emoji: "⚡", label: "Express / full-speed mode", correct: false },
        { emoji: "🔔", label: "The lobby call bell", correct: false },
      ],
    ),

    // Engineer practical (cabinet) + moderation judgement
    choice(
      "ENGINEER",
      4,
      "The cabin is on floor 3 and a call comes from floor 5. On the cabinet, which control sends it up?",
      null,
      [
        { emoji: "🔼", label: "Up direction", correct: true },
        { emoji: "🔽", label: "Down direction", correct: false },
        { emoji: "🛑", label: "Emergency stop", correct: false },
      ],
    ),
    choice(
      "ENGINEER",
      5,
      "A passenger is trapped between floors. What is the correct first cabinet action?",
      null,
      [
        { emoji: "🚪", label: "Level to the nearest floor, then open doors", correct: true },
        { emoji: "⚡", label: "Send the car express to the top", correct: false },
        { emoji: "🔧", label: "Power-cycle the whole lift", correct: false },
      ],
    ),
    choice(
      "ENGINEER",
      6,
      "A player is spamming and exploiting in the server. As an LE with Adonis, what do you do?",
      null,
      [
        { emoji: "🔨", label: "Warn, then kick/ban per the rules and log it", correct: true },
        { emoji: "🤷", label: "Ignore it — not your job", correct: false },
        { emoji: "🎁", label: "Give them admin to calm them down", correct: false },
      ],
    ),
  ];
}
