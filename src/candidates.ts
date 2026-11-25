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
  additionalRoots?: string[];
  type: ResultType;
  includeHidden: boolean;
  includeGlobs?: string;
  excludeGlobs?: string;
  excludeRegex?: string;
}

export function indexPath(supportPath: string, options: CandidateOptions) {
  const hash = createHash("sha256").update(JSON.stringify(options));
  if (options.includeGlobs?.trim()) hash.update("additive-includes");
  const key = hash.digest("hex");
  return join(supportPath, "candidates-v1", key);
}

function compileGlob(pattern: string) {
  const expanded = expandHome(pattern).replace(/\/+$/, "");
  const absolute = isAbsolute(expanded);
  const matcher = new Minimatch(expanded, { dot: true, nonegate: true, nocomment: true });
  const relative = expanded.includes("/");
  return (fullPath: string, relativePath: string) =>
    matcher.match(absolute ? fullPath : relative ? relativePath : basename(relativePath));
}

export function candidateRules(options: CandidateOptions) {
  const includes = splitPatterns(options.includeGlobs).map((pattern) => ({
    folderOnly: pattern.endsWith("/"),
    match: compileGlob(pattern),
  }));
  const excludes = splitPatterns(options.excludeGlobs).map(compileGlob);
  let regex: RegExp | undefined;
  try {
    regex = options.excludeRegex ? new RegExp(options.excludeRegex) : undefined;
  } catch (error) {
    throw new Error(`Invalid Exclude Regular Expression: ${(error as Error).message}`);
  }
  return {
    include: (path: string, relative: string, directory: boolean) =>
      includes.some(({ folderOnly, match }) => (!folderOnly || directory) && match(path, relative)),
    exclude: (path: string, relative: string) =>
      regex?.test(relative) || excludes.some((match) => match(path, relative)),
  };
}

type Folder = { path: string; relative: string; entries?: Dirent[] };

async function readFolder({ path, relative, entries }: Folder): Promise<Dirent[]> {
  if (entries) return entries;
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
      const roots = [options.root, ...(options.additionalRoots ?? [])];
      const pending: Folder[] = [];
      const failures: unknown[] = [];
      for (const path of roots) {
        signal.throwIfAborted();
        try {
          const entries = await readdir(path, { withFileTypes: true });
          pending.push({ path, relative: "", entries });
        } catch (error) {
          failures.push(error);
        }
      }
      if (!pending.length) throw failures[0];
      pending.reverse();

      while (pending.length > 0) {
        signal.throwIfAborted();
        const batch = pending.splice(-16).reverse();
        const contents = await Promise.all(batch.map(readFolder));
        const candidates: string[] = [];

        for (const [index, entries] of contents.entries()) {
          const parent = batch[index];
          for (const entry of entries) {
            const directory = entry.isDirectory();
            if (!directory && !entry.isFile()) continue;
            const path = join(parent.path, entry.name);
            const relative = parent.relative ? `${parent.relative}/${entry.name}` : entry.name;
            const hidden = !options.includeHidden && entry.name.startsWith(".");
            if ((hidden || rules.exclude(path, relative)) && !rules.include(path, relative, directory)) continue;
            if (directory) pending.push({ path, relative });
            const matchesType = directory ? options.type !== "files" : options.type !== "folders";
            if (matchesType) candidates.push(path);
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
