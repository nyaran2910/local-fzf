import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants, createReadStream } from "node:fs";
import { access, open } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { expandHome } from "./candidates";

const resultLimit = 60;

export async function findFzf(preference?: string) {
  const explicit = preference?.trim();
  const folders = [
    ...(process.env.PATH ?? "").split(delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".nix-profile/bin"),
    `/etc/profiles/per-user/${process.env.USER ?? ""}/bin`,
    "/run/current-system/sw/bin",
  ];
  const paths = explicit ? [expandHome(explicit)] : folders.filter(isAbsolute).map((folder) => join(folder, "fzf"));

  for (const path of new Set(paths)) {
    if (!isAbsolute(path)) break;
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Continue through the known installation paths.
    }
  }

  if (explicit) throw new Error(`Cannot run fzf at ${explicit}. Set an absolute executable path in preferences.`);
  throw new Error("fzf was not found. Install it or set FZF Executable in preferences.");
}

async function firstPaths(stream: Readable, atLimit?: () => void) {
  const paths: string[] = [];
  let remainder = "";
  stream.setEncoding("utf8");

  for await (const chunk of stream) {
    const records = (remainder + chunk).split("\0");
    remainder = records.pop() ?? "";
    for (const path of records) {
      paths.push(path);
      if (paths.length === resultLimit) {
        atLimit?.();
        return paths;
      }
    }
  }
  return paths;
}

export async function searchIndex(
  file: string,
  query: string,
  executable: string,
  exact: boolean,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!query.trim()) return firstPaths(createReadStream(file, { signal }));

  const input = await open(file, "r");
  try {
    signal.throwIfAborted();
    const env = { ...process.env };
    delete env.FZF_DEFAULT_OPTS;
    delete env.FZF_DEFAULT_OPTS_FILE;

    const args = ["--read0", "--print0", "--scheme=path"];
    if (exact) args.push("--exact");
    args.push(`--filter=${query}`);

    const child = spawn(executable, args, { env, stdio: [input.fd, "pipe", "pipe"], signal });
    assert(child.stdout && child.stderr);
    let capped = false;
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < 2048) stderr += chunk;
    });
    const closed = once(child, "close");
    try {
      const [paths, [code]] = await Promise.all([
        firstPaths(child.stdout, () => {
          capped = true;
          child.kill();
        }),
        closed,
      ]);
      signal.throwIfAborted();
      if (!capped && code !== 0 && !(code === 1 && !stderr.trim())) {
        throw new Error(stderr.trim() || `fzf exited with status ${code}.`);
      }
      return paths;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  } finally {
    await input.close();
  }
}
