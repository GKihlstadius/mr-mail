import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const { productName } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  root: 'src/renderer',
  base: './',
  // Appnamnet i index.html kommer från productName i package.json.
  plugins: [react(), { name: 'app-name', transformIndexHtml: (html: string) => html.replace(/%APP_NAME%/g, productName) }],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    target: 'chrome140'
  }
});
