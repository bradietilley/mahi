// @ts-check
import stylistic from "@stylistic/eslint-plugin";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettierConfig from "eslint-config-prettier";

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.sqlite", "**/coverage/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // Model files. `interface Post extends PostTable {}` alongside
    // `class Post extends Model` is THE documented way to type a model's
    // instance attributes (docs/models/README.md, "The two type
    // declarations") — and `make:model` generates exactly this, so every
    // app hits it too.
    //
    // Both rules fire on it, and neither is right here:
    //
    // - no-empty-object-type: the interface is empty *by design*. Its
    //   whole job is the declaration merge; members would defeat it.
    // - no-unsafe-declaration-merging: the rule guards against a class
    //   and interface disagreeing about a member's type. These can't
    //   disagree — the interface only re-exports the row type the class
    //   already declares via `Row`.
    //
    // Not deletable, either: without the merge, `session.expires_at`
    // stops type-checking (`framework/auth/src/session/database-session-store.ts`)
    // and the build fails.
    // Test files declare models inline for the same reason, so they are
    // covered too — a test model that couldn't use the real idiom
    // wouldn't be testing what real models do.
    files: ["**/models/**/*.ts", "**/*.model.ts", "**/tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unsafe-declaration-merging": "off",
    },
  },
  {
    // Type-level test files (`*.test-d.ts`) assert on the compiler, not at
    // runtime: `tsc` IS the assertion, so nothing in them is "used" in the
    // sense these rules mean.
    //
    // - unused-vars: every assertion is a type alias or a `const` that
    //   exists purely to be typechecked. Underscore-prefixed names are
    //   deliberate and are the convention this repo already uses for args.
    // - empty-object-type / unsafe-declaration-merging: `interface Post
    //   extends PostTable {}` alongside `class Post extends Model` is the
    //   documented way to type a model's instance attributes (see
    //   docs/models/README.md, "The two type declarations"). The fixtures
    //   must use it or they wouldn't be testing what real models do.
    files: ["**/*.test-d.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unsafe-declaration-merging": "off",
    },
  },
  prettierConfig,
  {
    // House style. Deliberately AFTER `prettierConfig`, which turns `curly`
    // off (it lists it as a rule Prettier "can" own). Prettier only reprints
    // the braces you already wrote — it will never add them — so leaving that
    // off would silently drop half of this section. Order matters here.
    //
    // These rules and Prettier split the work: ESLint decides WHERE the
    // braces and blank lines go, Prettier decides how the result is printed.
    // `if (a) return;` is fixed by ESLint to `if (a) {return;}`, and Prettier
    // then breaks it across lines. Both have to run to land the final shape,
    // which is why `format` runs `lint --fix` before `prettier --write`.
    //
    // Rules come from @stylistic rather than ESLint core: core's copies are
    // deprecated since 8.53 and are removed in v11.
    files: ["**/*.ts"],
    plugins: { "@stylistic": stylistic },
    rules: {
      // No single-line bodies: every if/else/for/while gets a block, so a
      // second statement can be added without a diff that hides control flow.
      curly: ["error", "all"],

      "@stylistic/padding-line-between-statements": [
        "error",
        // Breathing room before a branch, a loop, or a return: the reader
        // should see where the straight-line code stops.
        { blankLine: "always", prev: "*", next: ["if", "while", "for", "return"] },
        // ...and after a branch or loop closes, before the next statement.
        // `return` is absent by design — it ends the block, so "after" is
        // either nothing or a sibling that gets padded by the rule above.
        { blankLine: "always", prev: ["if", "while", "for"], next: "*" },
        // The "unless it's the first/last line of the parent body" carve-outs
        // are not configured: the rule only pads BETWEEN two statements, so
        // an if/for that opens or closes a block has no neighbour to pad
        // against and is left alone. Chained guard clauses still get padded
        // from each other, which is the case that matters.
      ],
    },
  },
];
