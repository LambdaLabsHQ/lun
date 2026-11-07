/**
 * The examples menu: every program in `examples/`, named by its file and
 * described by the first sentence of its leading comment.
 */

export interface ExampleFile {
  /** The file name, as in `decide.norn`. */
  file: string;
  source: string;
}

export interface Example extends ExampleFile {
  /** The file name without `.norn`: what `#example=` names. */
  name: string;
  /** The first sentence of the leading comment, or nothing. */
  summary: string;
}

export function describeExamples(files: readonly ExampleFile[]): Example[] {
  return files
    .map((example) => ({ ...example, name: example.file.replace(/\.norn$/, ""), summary: summary(example.source) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function summary(source: string): string {
  const comment: string[] = [];
  for (const line of source.split("\n")) {
    const match = /^\s*\/\/\s?(.*)$/.exec(line);
    if (match === null) break;
    comment.push(match[1]!.trim());
  }
  const text = comment.join(" ").trim();
  const sentence = /^.*?[.!?](?=\s|$)/.exec(text);
  return sentence === null ? text : sentence[0];
}
