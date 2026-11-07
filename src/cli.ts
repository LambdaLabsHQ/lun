#!/usr/bin/env node
/**
 * The `norn` command line. Run it with `npm run norn -- <command>` or
 * `node src/cli.ts <command>`; `npm link` puts `norn` on the PATH.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import {
  STACK_EXHAUSTED, astToJson, formatDiagnostic, isStackExhausted, parse, treeLines, type Diagnostic,
} from "./frontend/index.ts";
import { checkSource, readInterface, type CheckDiagnostic, type EffectSummary } from "./frontend/check/index.ts";
import { referenceHostPath, standardLibrary } from "./frontend/check/node.ts";

const usage = `Usage: norn <command> [options]

Commands:
  parse [--json] <file>     Print the syntax tree of a .norn file as an outline, or as
                            norn-ast JSON on one line ('-' reads standard input)
  check [--host <file>] [--json] <path>...
                            Parse and type-check .norn files, and the .norn files under
                            directories ('-' reads standard input). Programs see the
                            host interface file given with --host, by default
                            hosts/reference.norn; that file itself is checked as an
                            interface. --json prints one JSON document with each
                            file's diagnostics and effects summary.
  help                      Show this help

Exit status: 0 without errors (warnings allowed), 1 if a file has errors,
2 on a usage or read error.
`;

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(usage);
        return 0;
      case "parse":
        return await parseCommand(args);
      case "check":
        return await checkCommand(args);
      default:
        throw new UsageError(`unknown command '${command}'\n\n${usage}`);
    }
  } catch (error) {
    if (isStackExhausted(error)) {
      process.stderr.write(`norn: ${STACK_EXHAUSTED}\n`);
      return 1;
    }
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`norn: ${error.message.endsWith("\n") ? error.message : `${error.message}\n`}`);
    return 2;
  }
}

async function parseCommand(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const files = args.filter((arg) => arg !== "--json");
  const option = files.find((arg) => arg.startsWith("-") && arg !== "-");
  if (option !== undefined) throw new UsageError(`unknown option '${option}' for parse`);
  const [file] = files;
  if (file === undefined || files.length > 1) throw new UsageError("parse takes exactly one file");
  const source = await read(file);
  const result = parse(source);
  if (!result.ok) {
    report(result.diagnostics, source, displayName(file));
    return 1;
  }
  if (json) {
    process.stdout.write(`${astToJson(result.program)}\n`);
  } else {
    // Written in pieces: the outline of a very deep tree is too large to hold as one string.
    let chunk = "";
    for (const line of treeLines(result.program)) {
      chunk += `${line}\n`;
      if (chunk.length >= 1 << 16) {
        process.stdout.write(chunk);
        chunk = "";
      }
    }
    process.stdout.write(chunk);
  }
  return 0;
}

interface CheckedFile {
  file: string;
  ok: boolean;
  /** A host interface file, checked as one. */
  interface: boolean;
  diagnostics: CheckDiagnostic[];
  effects: EffectSummary[] | null;
}

async function checkCommand(args: string[]): Promise<number> {
  let json = false;
  let hostOption: string | null = null;
  const paths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") json = true;
    else if (arg === "--host" || arg.startsWith("--host=")) {
      const value = arg === "--host" ? args[++index] : arg.slice("--host=".length);
      if (value === undefined || value === "") throw new UsageError("--host needs an interface file, as in --host hosts/reference.norn");
      if (hostOption !== null) throw new UsageError("--host is given twice");
      hostOption = value;
    } else if (arg.startsWith("-") && arg !== "-") throw new UsageError(`unknown option '${arg}' for check`);
    else paths.push(arg);
  }
  if (paths.length === 0) throw new UsageError("check needs at least one file or directory");

  const hostPath = hostOption ?? referenceHostPath();
  const hostName = hostOption ?? relativeName(hostPath);
  const hostSource = await read(hostPath);
  const host = readInterface(hostSource, hostName);
  const files = paths.flatMap(expand);
  const results: CheckedFile[] = [];
  const sources = new Map<string, string>();
  if (host.ok) {
    const hostReal = realPath(hostPath);
    const std = standardLibrary(host);
    for (const file of files) {
      const source = await read(file);
      const name = displayName(file);
      sources.set(name, source);
      if (file !== "-" && realPath(file) === hostReal) {
        results.push({ file: name, ok: true, interface: true, diagnostics: [...host.diagnostics], effects: null });
        continue;
      }
      const result = checkSource(source, { host, std });
      results.push({ file: name, ok: result.ok, interface: false, diagnostics: result.diagnostics, effects: result.effects });
    }
  }
  if (json) {
    const document = {
      host: { file: hostName, ok: host.ok, diagnostics: host.diagnostics.map(jsonDiagnostic) },
      files: results.map((result) => ({
        file: result.file,
        ok: result.ok,
        ...(result.interface ? { interface: true } : {}),
        diagnostics: result.diagnostics.map(jsonDiagnostic),
        effects: result.effects,
      })),
    };
    process.stdout.write(`${JSON.stringify(document)}\n`);
  } else {
    if (!host.ok) report(host.diagnostics, hostSource, hostName);
    for (const result of results) {
      report(result.diagnostics, sources.get(result.file) ?? "", result.file);
      if (result.ok) process.stdout.write(`${result.file}: ok${result.interface ? " (host interface)" : ""}\n`);
    }
  }
  return !host.ok || results.some((result) => !result.ok) ? 1 : 0;
}

/** A diagnostic as `norn check --json` prints it: severity, code, message, span, then expected, found or missing where they apply. */
function jsonDiagnostic(diagnostic: CheckDiagnostic): object {
  const { severity, code, message, span, expected, found, missing } = diagnostic;
  return {
    severity,
    code,
    message,
    span,
    ...(expected === undefined ? {} : { expected }),
    ...(found === undefined ? {} : { found }),
    ...(missing === undefined ? {} : { missing }),
  };
}

function relativeName(path: string): string {
  const name = relative(process.cwd(), path);
  return name.startsWith("..") ? path : name;
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function report(diagnostics: readonly Diagnostic[], source: string, file: string): void {
  for (const diagnostic of diagnostics) {
    process.stderr.write(`${formatDiagnostic(diagnostic, source, file)}\n\n`);
  }
}

function displayName(file: string): string {
  return file === "-" ? "<stdin>" : file;
}

/** A file, or standard input for '-'. Standard input is read as a stream: a pipe may not be readable at once. */
async function read(file: string): Promise<string> {
  try {
    if (file !== "-") return readFileSync(file, "utf8");
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    throw new UsageError(`cannot read ${file}: ${describeError(error)}`);
  }
}

/** A file stays itself; a directory becomes the .norn files under it, sorted. */
function expand(path: string): string[] {
  if (path === "-") return [path];
  let isDirectory: boolean;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch (error) {
    throw new UsageError(`cannot read ${path}: ${describeError(error)}`);
  }
  if (!isDirectory) return [path];
  const files: string[] = [];
  const walk = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const child = join(directory, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".norn")) files.push(child);
    }
  };
  walk(path);
  if (files.length === 0) throw new UsageError(`no .norn files under ${path}`);
  return files;
}

function describeError(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT") return "no such file or directory";
  if (code === "EISDIR") return "it is a directory";
  return error instanceof Error ? error.message : String(error);
}

process.exitCode = await main(process.argv.slice(2));
