/**
 * The program in the URL fragment, so that a link reproduces it. An example
 * that is not edited is named, as in `#example=decide`; any other program is
 * compressed, as in `#code=…`: raw DEFLATE of its UTF-8 text, in base64url.
 * The fragment never reaches a server.
 */

export type Fragment =
  | { kind: "example"; name: string }
  | { kind: "code"; source: string }
  /** No program in the fragment. */
  | { kind: "none" }
  /** A program that cannot be read back, such as a link cut short. */
  | { kind: "unreadable" };

/** The fragment, with its `#`, for a program: by name when it is an unedited example. */
export async function fragmentFor(source: string, example: string | null): Promise<string> {
  if (example !== null) return `#example=${encodeURIComponent(example)}`;
  return `#code=${base64url(await transform(new TextEncoder().encode(source), new CompressionStream("deflate-raw")))}`;
}

/** What a fragment, such as `location.hash`, holds. */
export async function readFragment(hash: string): Promise<Fragment> {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const example = params.get("example");
  if (example !== null && example !== "") return { kind: "example", name: example };
  const code = params.get("code");
  if (code === null) return { kind: "none" };
  try {
    const bytes = await transform(fromBase64url(code), new DecompressionStream("deflate-raw"));
    return { kind: "code", source: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { kind: "unreadable" };
  }
}

async function transform(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const output = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(output).arrayBuffer());
}

function base64url(bytes: Uint8Array): string {
  // In pieces: a spread of a long array would overflow the stack.
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
