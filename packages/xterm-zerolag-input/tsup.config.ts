import { defineConfig } from 'tsup';

export default defineConfig([
  // Standard builds (CJS + ESM + DTS)
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
  },
  // IIFE build for browser <script> tag usage
  {
    entry: ['src/index.ts'],
    format: ['iife'],
    globalName: 'XtermZerolagInput',
    outDir: 'dist',
    // Append global aliases so app.js can access classes directly
    footer: {
      js: [
        '// Global aliases for browser usage',
        'if(typeof window!=="undefined"){',
        '  window.ZerolagInputAddon=XtermZerolagInput.ZerolagInputAddon;',
        '  window.LocalEchoOverlay=class extends XtermZerolagInput.ZerolagInputAddon{',
        '    constructor(terminal){',
        '      super({prompt:{type:"character",char:"\\u276f",offset:2}});',
        '      this.activate(terminal);',
        '    }',
        '  };',
        '}',
      ].join('\n'),
    },
  },
]);
