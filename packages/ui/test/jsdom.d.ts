declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: object);
    window: { document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null } };
  }
}
