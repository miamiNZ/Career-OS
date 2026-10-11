// Flat ESLint config (ESM). TypeScript + Node, recommended rulesets tuned to this
// project's style. Goal: catch real problems, not force churn. Type-aware linting is
// enabled via projectService so rules like no-floating-promises work.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Not linted: build output, deps, the browser dashboard bundle (its own runtime,
    // no TS/Node globals), and JS config files.
    ignores: ["dist/**", "node_modules/**", "src/web/**", "*.config.js", "eslint.config.js", "tests/**", "vitest.config.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The codebase deliberately uses `any` at the untyped edges (JSON from
      // undocumented job-board APIs, gray-matter frontmatter). Warn-free requires this
      // off; the parsing code validates/narrows before use.
      "@typescript-eslint/no-explicit-any": "off",
      // Allow intentionally-unused args when prefixed with _ (stub signatures like
      // previewApplication(_job, _docs) and ignored callback params).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
);
