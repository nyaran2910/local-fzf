import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Minimatch } from "minimatch";

export const resultTypes = ["both", "files", "folders"] as const;
export type ResultType = (typeof resultTypes)[number];

export function expandHome(path: string) {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function splitPatterns(value = "") {
  return value.split(/[;\n]/).map((part) => part.trim()).filter(Boolean);
}

export function readCustomRoots(value?: string) {
  const paths = splitPatterns(value).map(expandHome);
  if (paths.some((path) => !isAbsolute(path))) {
    throw new Error("Custom search locations must be absolute paths or start with ~/.");
  }
  return [...new Set(paths.map((path) => resolve(path)))];
}

export interface CandidateOptions {
  root: string;
  type: ResultType;
  includeHidden: boolean;
  includeGlobs?: string;
  excludeGlobs?: string;
  excludeRegex?: string;
}

export function indexPath(supportPath: string, options: CandidateOptions) {
  const key = createHash("sha256").update(JSON.stringify(options)).digest("hex");
  return join(supportPath, "candidates-v1", key);
}

function compileGlobs(value?: string) {
  return splitPatterns(value).map((pattern) => {
    const expanded = expandHome(pattern).replace(/\/+$/, "");
    const absolute = isAbsolute(expanded);
    const matcher = new Minimatch(expanded, { dot: true, nonegate: true, nocomment: true });
    return (fullPath: string, relativePath: string) =>
      matcher.match(absolute ? fullPath : expanded.includes("/") ? relativePath : basename(relativePath));
  });
}

export function candidateRules(options: CandidateOptions) {
  const includes = compileGlobs(options.includeGlobs);
  const excludes = compileGlobs(options.excludeGlobs);
  let regex: RegExp | undefined;
  try {
    regex = options.excludeRegex ? new RegExp(options.excludeRegex) : undefined;
  } catch (error) {
    throw new Error(`Invalid Exclude Regular Expression: ${(error as Error).message}`);
  }
  return {
    include: (path: string, relative: string) =>
      includes.length === 0 || includes.some((match) => match(path, relative)),
    exclude: (path: string, relative: string) =>
      regex?.test(relative) || excludes.some((match) => match(path, relative)),
  };
}

type Folder = { path: string; relative: string };

async function readFolder({ path, relative }: Folder): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (relative && (code === "EACCES" || code === "EPERM" || code === "ENOENT" || code === "ENOTDIR")) return [];
    throw error;
  }
}

export async function refreshIndex(file: string, options: CandidateOptions, signal: AbortSignal) {
  const rules = candidateRules(options);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;

  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      const pending: Folder[] = [{ path: options.root, relative: "" }];

      while (pending.length > 0) {
        signal.throwIfAborted();
        const batch = pending.splice(-16).reverse();
        const contents = await Promise.all(batch.map(readFolder));
        const candidates: string[] = [];

        for (const [index, entries] of contents.entries()) {
          const parent = batch[index];
          for (const entry of entries) {
            if (!options.includeHidden && entry.name.startsWith(".")) continue;
            const directory = entry.isDirectory();
            if (!directory && !entry.isFile()) continue;
            const path = join(parent.path, entry.name);
            const relative = parent.relative ? `${parent.relative}/${entry.name}` : entry.name;
            if (rules.exclude(path, relative)) continue;
            if (directory) pending.push({ path, relative });
            const matchesType = directory ? options.type !== "files" : options.type !== "folders";
            if (matchesType && rules.include(path, relative)) candidates.push(path);
          }
        }

        signal.throwIfAborted();
        if (candidates.length) await handle.writeFile(candidates.join("\0") + "\0");
      }
    } finally {
      await handle.close();
    }
    signal.throwIfAborted();
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
