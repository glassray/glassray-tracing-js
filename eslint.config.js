import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * Flat ESLint config for a zero-dependency Node/TypeScript library —
 * deliberately self-contained so the package carries its own ruleset
 * everywhere it lives.
 */
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", ".turbo/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
);
