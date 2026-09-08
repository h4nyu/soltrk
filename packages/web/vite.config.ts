import { defineConfig } from "vite";

// The client lives in client/ rather than src/ so the repo's root tsconfig
// (include: packages/*/src) type-checks this package's Node server without
// also trying to compile browser code as CommonJS. See tsconfig.json here.
export default defineConfig({
  root: "client",
  build: {
    // Served by src/server.ts in production, which resolves this path
    // relative to the package directory.
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5173,
    // `npm run dev` serves the UI with HMR while the API comes from a
    // separately started `soltrk-web` server (npx tsx packages/web/src/cli.ts).
    proxy: { "/api": "http://localhost:8080" },
  },
});
