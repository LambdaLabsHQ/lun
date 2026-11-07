/** Norn files are bundled as their text. */
declare module "*.norn" {
  const source: string;
  export default source;
}

/** Every program in examples/, as the build finds them. */
declare module "norn:examples" {
  const examples: { file: string; source: string }[];
  export default examples;
}

/** The checking worker's file name, next to the page's script. */
declare const CHECK_WORKER: string;
/** Whether the page reloads itself when the development server rebuilds it. */
declare const LIVE_RELOAD: boolean;
