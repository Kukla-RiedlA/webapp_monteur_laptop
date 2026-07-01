import { defineConfig } from 'vite';

import react from '@vitejs/plugin-react';



export default defineConfig({

  plugins: [react()],

  base: './',

  server: { port: 5174, open: true },

  build: {

    outDir: '../electron/public/serviceprotokoll-react',

    emptyOutDir: true,

  },

});


