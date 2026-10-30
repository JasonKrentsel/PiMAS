import { shellQuote, type Workspace } from "./workspace.js";

/**
 * Whole-filesystem change tracking inside the workspace. Manifests (path, mtime, size, mode)
 * stay in the workspace under SNAPSHOT_DIR and are diffed there, so only the changes cross the
 * relay. pimas_harbor/agent.py builds the run-level manifests with the same command.
 */
export const SNAPSHOT_DIR = "/tmp/.pimas";

export interface FileChanges {
  created: string[];
  modified: string[];
  deleted: string[];
  /** Total changes; the lists stop at the listing limit when this is larger. */
  total: number;
  truncated: boolean;
  /** Time spent scanning and diffing: the tracking overhead for this stage. */
  overheadMs: number;
}

const MAX_LISTED_CHANGES = 20_000;
const SCAN_TIMEOUT_SECONDS = 600;

// Kernel/runtime filesystems, Harbor's /logs mount, and this tracker's own files.
const PRUNED = ["/proc", "/sys", "/dev", "/run", "/logs", SNAPSHOT_DIR];

const PERL_STAT = `chomp; my @s = lstat($_) or next; printf "%s\\t%d\\t%d\\t%o\\n", $_, $s[9], $s[7], $s[2] & 07777`;

/** GNU find when available (task images), otherwise find + perl (macOS, tests). */
export function manifestCommand(root: string, output: string): string {
  const prune = `\\( ${PRUNED.map((entry) => `-path ${shellQuote(entry)}`).join(" -o ")} \\) -prune -o`;
  const select = `${shellQuote(root)} ${prune} \\( -type f -o -type l \\)`;
  return `mkdir -p ${shellQuote(SNAPSHOT_DIR)} && if find / -maxdepth 0 -printf '' >/dev/null 2>&1; `
    + `then find ${select} -printf '%p\\t%T@\\t%s\\t%m\\n'; `
    + `else find ${select} -print | perl -ne ${shellQuote(PERL_STAT)}; fi > ${shellQuote(output)} 2>/dev/null; true`;
}

/** Created (C), modified (M), and deleted (D) paths between two manifests, sorted. */
export function diffCommand(before: string, after: string, output: string): string {
  const awk = `NR==FNR { seen[$1] = $0; next } { if (!($1 in seen)) print "C\\t" $1; else if (seen[$1] != $0) print "M\\t" $1; delete seen[$1] } END { for (path in seen) print "D\\t" path }`;
  return `awk -F '\\t' ${shellQuote(awk)} ${shellQuote(before)} ${shellQuote(after)} | LC_ALL=C sort > ${shellQuote(output)}`;
}

export interface Snapshot {
  file: string;
  scanMs: number;
}

export class FileTracker {
  private sequence = 0;

  constructor(private readonly workspace: Workspace, private readonly root: string, private readonly prefix: string) {}

  /** Record the current manifest in the workspace; null if scanning failed. */
  async snapshot(): Promise<Snapshot | null> {
    const file = `${SNAPSHOT_DIR}/${this.prefix}-${++this.sequence}.tsv`;
    const started = Date.now();
    try {
      const result = await this.workspace.exec(manifestCommand(this.root, file), { timeoutSeconds: SCAN_TIMEOUT_SECONDS });
      return result.exitCode === 0 ? { file, scanMs: Date.now() - started } : null;
    } catch {
      return null;
    }
  }

  /** Changes since `before`. Both manifests are removed afterwards. */
  async changesSince(before: Snapshot | null): Promise<FileChanges | null> {
    if (!before) return null;
    const after = await this.snapshot();
    const changes = await this.diff(before, after);
    await this.discard(before, after);
    if (changes) changes.overheadMs += before.scanMs;
    return changes;
  }

  /** Changes from `before` to `after`; both manifests are kept. Overhead is `after`'s scan plus the diff. */
  async diff(before: Snapshot | null, after: Snapshot | null): Promise<FileChanges | null> {
    if (!before || !after) return null;
    const started = Date.now();
    const diff = `${after.file}.diff`;
    try {
      const result = await this.workspace.exec(
        `${diffCommand(before.file, after.file, diff)} && wc -l < ${shellQuote(diff)} && head -n ${MAX_LISTED_CHANGES} ${shellQuote(diff)}; `
          + `rm -f ${shellQuote(diff)}`,
        { timeoutSeconds: SCAN_TIMEOUT_SECONDS },
      );
      if (result.exitCode !== 0) return null;
      const [count = "0", ...lines] = result.stdout.split("\n");
      const changes: FileChanges = {
        created: [], modified: [], deleted: [], total: Number(count.trim()) || 0, truncated: false, overheadMs: 0,
      };
      for (const line of lines) {
        const tab = line.indexOf("\t");
        if (tab < 0) continue;
        const kind = line.slice(0, tab);
        const file = line.slice(tab + 1);
        if (kind === "C") changes.created.push(file);
        else if (kind === "M") changes.modified.push(file);
        else if (kind === "D") changes.deleted.push(file);
      }
      changes.truncated = changes.total > changes.created.length + changes.modified.length + changes.deleted.length;
      changes.overheadMs = after.scanMs + (Date.now() - started);
      return changes;
    } catch {
      return null;
    }
  }

  async discard(...snapshots: (Snapshot | null)[]): Promise<void> {
    const files = snapshots.flatMap((snapshot) => (snapshot ? [shellQuote(snapshot.file)] : []));
    if (!files.length) return;
    try {
      await this.workspace.exec(`rm -f ${files.join(" ")}`, { timeoutSeconds: SCAN_TIMEOUT_SECONDS });
    } catch {
      // Leftover manifests are pruned from later scans and go away with the container.
    }
  }
}
