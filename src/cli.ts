#!/usr/bin/env node
/**
 * The `norn` command line. Run it with `npm run norn -- <command>` or
 * `node src/cli.ts <command>`; `npm link` puts `norn` on the PATH.
 */
import process from "node:process";

const usage = `Usage: norn <command> [options]

Commands:
  parse [--json] <file>   Print the syntax tree of a .norn file
  check <path>...         Report syntax errors in .norn files and directories
  help                    Show this help

The parser is not implemented yet.
`;

type Command = (args: string[]) => number;

const commands: { [name: string]: Command } = {
  help: () => {
    process.stdout.write(usage);
    return 0;
  },
  parse: () => notYet("parse"),
  check: () => notYet("check"),
};

function notYet(command: string): number {
  process.stderr.write(`norn ${command}: the parser is not implemented yet\n`);
  return 1;
}

function main(argv: string[]): number {
  const [name, ...args] = argv;
  if (name === undefined || name === "--help" || name === "-h") return commands["help"]!(args);
  const command = commands[name];
  if (command === undefined) {
    process.stderr.write(`norn: unknown command '${name}'\n\n${usage}`);
    return 2;
  }
  return command(args);
}

process.exitCode = main(process.argv.slice(2));
