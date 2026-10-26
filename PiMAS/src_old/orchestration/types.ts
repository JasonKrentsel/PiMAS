export type AgentRole = "planner" | "executor" | "reviewer";

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskSpec {
  id: string;
  title: string;
  role: AgentRole;
  instructions: string;
  dependsOn: string[];
  files: string[];
}

export interface Phase {
  title: string;
  tasks: TaskSpec[];
}

export interface Review {
  approved: boolean;
  feedback: string;
}

export interface AgentTask extends TaskSpec {
  phase: number;
  status: TaskStatus;
  result?: string;
  review?: Review;
}

/** The scheduler knows about tasks; this adapter knows how to run Pi conversations. */
export interface AgentDriver {
  run(task: AgentTask, context: string, signal: AbortSignal): Promise<string>;
  send(taskId: string, message: string): Promise<void>;
}

export interface AgentUpdate {
  type: "started" | "completed" | "failed" | "message" | "question";
  taskId: string;
  text: string;
  questionId?: string;
}

export interface PendingQuestion {
  id: string;
  taskId: string;
}

export interface OrchestratorStatus {
  phases: string[];
  tasks: AgentTask[];
  pendingQuestions: PendingQuestion[];
  complete: boolean;
  stopped?: string;
  plansUsed: number;
}
