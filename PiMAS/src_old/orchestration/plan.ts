import path from "node:path";
import type { AgentTask, Phase, TaskSpec } from "./types.js";

/** Validate the whole replacement before changing any scheduler state. */
export function validatePlan(
  phases: Phase[],
  previousTasks: ReadonlyMap<string, AgentTask>,
  maxTasks: number,
): void {
  if (phases.length === 0) {
    throw new Error("Each phase needs a title and tasks");
  }

  const phaseByTaskId = new Map<string, number>();
  const tasks = phases.flatMap((phase) => phase.tasks);

  if (previousTasks.size + tasks.length > maxTasks) {
    throw new Error(`Task budget is ${maxTasks}; use fewer tasks or stop`);
  }

  for (const [phaseIndex, phase] of phases.entries()) {
    if (!phase.title.trim() || phase.tasks.length === 0) {
      throw new Error("Each phase needs a title and tasks");
    }

    for (const task of phase.tasks) {
      const idIsValid = /^[a-zA-Z0-9_-]+$/.test(task.id);
      const idAlreadyUsed = phaseByTaskId.has(task.id) || previousTasks.has(task.id);

      if (!idIsValid || idAlreadyUsed) {
        throw new Error(`Task IDs must be unique, including prior plans: ${task.id}`);
      }

      validateTask(task);
      phaseByTaskId.set(task.id, phaseIndex);
    }
  }

  if (!tasks.some((task) => task.role === "executor")) {
    throw new Error("Include at least one executor");
  }

  const finalPhase = phases[phases.length - 1]!;
  if (!finalPhase.tasks.every((task) => task.role === "reviewer")) {
    throw new Error("The final phase must contain only reviewers");
  }

  validateDependencies(tasks, phaseByTaskId);
  rejectDependencyCycles(tasks);
}

function validateTask(task: TaskSpec): void {
  const knownRole = ["planner", "executor", "reviewer"].includes(task.role);
  if (!knownRole || !task.title.trim() || !task.instructions.trim()) {
    throw new Error(`Invalid task ${task.id}`);
  }

  if (task.role === "executor" && task.files.length === 0) {
    throw new Error(
      `Executor ${task.id} needs file/directory scopes (use . for the whole project)`,
    );
  }

  for (const file of task.files) {
    normalizeScope(file);
  }
}

function validateDependencies(
  tasks: TaskSpec[],
  phaseByTaskId: ReadonlyMap<string, number>,
): void {
  for (const task of tasks) {
    const taskPhase = phaseByTaskId.get(task.id)!;

    for (const dependencyId of task.dependsOn) {
      const dependencyPhase = phaseByTaskId.get(dependencyId);
      if (dependencyPhase === undefined || dependencyPhase > taskPhase) {
        throw new Error(`Invalid dependency ${dependencyId} for ${task.id}`);
      }
    }
  }
}

function rejectDependencyCycles(tasks: TaskSpec[]): void {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(taskId: string): void {
    if (visiting.has(taskId)) {
      throw new Error("Task dependencies contain a cycle");
    }
    if (visited.has(taskId)) {
      return;
    }

    visiting.add(taskId);
    for (const dependencyId of tasksById.get(taskId)!.dependsOn) {
      visit(dependencyId);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  }

  for (const task of tasks) {
    visit(task.id);
  }
}

function normalizeScope(scope: string): string {
  const normalized = path.posix.normalize(scope.replaceAll("\\", "/").trim());
  const escapesProject = normalized === ".." || normalized.startsWith("../");
  const absolutePath = path.posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized);
  const containsGlob = /[*?]/.test(normalized);

  if (!scope.trim() || escapesProject || absolutePath || containsGlob) {
    throw new Error(`Use a relative file or directory scope without globs: ${scope}`);
  }

  const comparable = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return comparable.replace(/\/$/, "");
}

/** A directory owns its descendants; similarly named siblings do not overlap. */
export function scopesOverlap(left: string[], right: string[]): boolean {
  for (const leftScope of left) {
    for (const rightScope of right) {
      const first = normalizeScope(leftScope);
      const second = normalizeScope(rightScope);
      const wholeProject = first === "." || second === ".";
      const samePath = first === second;
      const parentOrChild = first.startsWith(`${second}/`) || second.startsWith(`${first}/`);

      if (wholeProject || samePath || parentOrChild) {
        return true;
      }
    }
  }
  return false;
}
