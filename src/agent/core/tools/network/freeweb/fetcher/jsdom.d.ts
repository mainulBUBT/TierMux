// Ambient declaration for jsdom. jsdom ships no bundled types and TierMux has no
// DOM lib; declaring just the surface we use keeps the engine self-contained
// (no @types/jsdom, no DOM-lib pollution). The document is typed loosely; the
// http fetcher narrows it via its own DomDocument interface at the call site.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html: string);
    window: { document: any };
  }
}
