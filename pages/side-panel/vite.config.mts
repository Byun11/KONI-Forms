import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { withPageConfig } from '@extension/vite-config';

const rootDir = resolve(__dirname);
const srcDir = resolve(rootDir, 'src');
const outDir = resolve(rootDir, '..', '..', 'dist', 'side-panel');

// pdf.js needs its 14 standard PDF fonts (Helvetica, ZapfDingbats checkmark
// glyphs, …) at runtime for PDFs that don't embed them; ship them next to the
// bundle so pdfParse.ts can point standardFontDataUrl at them.
const copyPdfStandardFonts = () => ({
  name: 'copy-pdfjs-standard-fonts',
  closeBundle() {
    cpSync(resolve(rootDir, 'node_modules/pdfjs-dist/standard_fonts'), resolve(outDir, 'standard_fonts'), {
      recursive: true,
    });
  },
});

export default withPageConfig({
  resolve: {
    alias: {
      '@src': srcDir,
    },
  },
  plugins: [copyPdfStandardFonts()],
  publicDir: resolve(rootDir, 'public'),
  build: {
    outDir,
  },
});
