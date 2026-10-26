import type { AgentUpdate, PendingQuestion } from "./types.js";

interface QuestionWaiter {
  taskId: string;
  resolve(reply: string): void;
  reject(error: Error): void;
}

/** Workers post here. Only the orchestrator takes updates and answers questions. */
export class Mailbox {
  private readonly updates: AgentUpdate[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly questions = new Map<string, QuestionWaiter>();
  private nextQuestionId = 1;
  private closed = false;

  constructor(private readonly onUpdate: (update: AgentUpdate) => void) {}

  post(update: AgentUpdate): void {
    this.updates.push(update);
    this.onUpdate(update);
    this.wakeListeners();
  }

  pendingQuestions(): PendingQuestion[] {
    return [...this.questions].map(([id, question]) => ({
      id,
      taskId: question.taskId,
    }));
  }

  async takeUpdates(signal?: AbortSignal, timeoutMs = 15_000): Promise<AgentUpdate[]> {
    signal?.throwIfAborted();

    if (this.updates.length === 0 && !this.closed) {
      await this.waitForMessage(signal, timeoutMs);
    }

    return this.updates.splice(0);
  }

  ask(taskId: string, text: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();

    const alreadyWaiting = [...this.questions.values()].some(
      (question) => question.taskId === taskId,
    );
    if (alreadyWaiting) {
      throw new Error("This agent already has a pending question");
    }

    const questionId = `q${this.nextQuestionId++}`;

    return new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        this.questions.delete(questionId);
        signal?.removeEventListener("abort", cancel);
      };
      const cancel = () => {
        cleanup();
        reject(new Error("Question cancelled"));
      };

      this.questions.set(questionId, {
        taskId,
        resolve: (reply) => {
          cleanup();
          resolve(reply);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });

      signal?.addEventListener("abort", cancel, { once: true });
      this.post({ type: "question", taskId, text, questionId });
    });
  }

  reply(questionId: string, text: string): void {
    const question = this.questions.get(questionId);
    if (!question) {
      throw new Error(`No pending question ${questionId}`);
    }
    question.resolve(text);
  }

  close(reason: string): void {
    this.closed = true;
    for (const question of [...this.questions.values()]) {
      question.reject(new Error(reason));
    }
    this.wakeListeners();
  }

  private waitForMessage(signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(wake);
        signal?.removeEventListener("abort", cancel);
      };
      const wake = () => {
        cleanup();
        resolve();
      };
      const cancel = () => {
        cleanup();
        reject(signal?.reason ?? new Error("Aborted"));
      };
      const timer = setTimeout(wake, timeoutMs);

      this.listeners.add(wake);
      signal?.addEventListener("abort", cancel, { once: true });
    });
  }

  private wakeListeners(): void {
    for (const notify of this.listeners) {
      notify();
    }
  }
}
