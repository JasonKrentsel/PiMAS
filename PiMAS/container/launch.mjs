import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The host supervises this process group even if the bridge exits first.
if (process.argv.length < 3) throw new Error("Supply the installed bridge or smoke script");
const child = spawn(process.execPath, [
  "--import", pathToFileURL("/opt/pimas/node_modules/tsx/dist/loader.mjs").href,
  ...process.argv.slice(2),
], { cwd: "/app", detached: true, stdio: "inherit" });
if (child.pid) writeFileSync("/pimas-state/harness.pid", String(child.pid));
child.once("error", (error) => { console.error(error); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
