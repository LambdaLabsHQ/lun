#!/usr/bin/env node
/**
 * The `norn` command line. Run it with `npm run norn -- <command>` or
 * `node src/cli.ts <command>`; `npm link` puts `norn` on the PATH.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  STACK_EXHAUSTED, astToJson, formatDiagnostic, isStackExhausted, parse, treeLines, type Diagnostic,
} from "./frontend/index.ts";

const usage = `Usage: norn <command> [options]

Commands:
  parse [--json] <file>   Print the syntax tree of a .norn file as an outline, or as
                          norn-ast JSON on one line ('-' reads standard input)
  check <path>...         Report syntax errors in .norn files and in directories of them
  help                    Show this help

Exit status: 0 without errors, 1 if a file has syntax errors, 2 on a usage or read error.
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

async function checkCommand(args: string[]): Promise<number> {
  if (args.length === 0) throw new UsageError("check needs at least one file or directory");
  let failed = 0;
  for (const file of args.flatMap(expand)) {
    const source = await read(file);
    const result = parse(source);
    if (result.ok) {
      process.stdout.write(`${displayName(file)}: ok\n`);
    } else {
      failed += 1;
      report(result.diagnostics, source, displayName(file));
    }
  }
  return failed > 0 ? 1 : 0;
}

function report(diagnostics: Diagnostic[], source: string, file: string): void {
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
