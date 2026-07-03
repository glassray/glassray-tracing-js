import { defineConfig } from "tsup";

/**
 * Builds the publishable `@glassray/tracing` dist: dual ESM + CJS with type
 * declarations, targeting the package's `engines.node >= 18` floor.
 * Deliberately unminified with sourcemaps — readable dist on npm is part of
 * the trust posture for a library that sees prompts.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  // The dts worker passes compiler options programmatically, where TS 6
  // rejects an inherited `incremental: true` (TS5074) and errors on the
  // `baseUrl` tsup injects (TS5101). Scoped here so the package tsconfig
  // and `tsc --noEmit` typechecking stay untouched.
  dts: { compilerOptions: { incremental: false, ignoreDeprecations: "6.0" } },
  target: "node18",
  platform: "node",
  clean: true,
  sourcemap: true,
  minify: false,
});
