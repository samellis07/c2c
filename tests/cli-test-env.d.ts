declare module '*.mjs' {
  export function cleanCliEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}
