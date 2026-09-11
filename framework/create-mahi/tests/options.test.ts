import { describe, expect, it } from "vitest";
import { isValidProjectName, parseArgs, toProjectName } from "../src/options.js";
import { detectPackageManager, installCommand, runScript } from "../src/pm.js";

describe("parseArgs", () => {
  it("defaults every step to enabled", () => {
    const options = parseArgs(["my-app"]);

    expect(options).toEqual({
      directory: "my-app",
      install: true,
      migrate: true,
      git: true,
      linkWorkspace: false,
      force: false,
      yes: false,
    });
  });

  it("parses the --no-* opt-outs", () => {
    const options = parseArgs(["my-app", "--no-install", "--no-migrate", "--no-git"]);

    expect(options.install).toBe(false);
    expect(options.migrate).toBe(false);
    expect(options.git).toBe(false);
  });

  it("parses --pm in both spellings", () => {
    expect(parseArgs(["a", "--pm", "pnpm"]).pm).toBe("pnpm");
    expect(parseArgs(["a", "--pm=bun"]).pm).toBe("bun");
  });

  it("rejects an unknown package manager", () => {
    expect(() => parseArgs(["a", "--pm", "cargo"])).toThrow(/--pm expects one of/);
    expect(() => parseArgs(["a", "--pm"])).toThrow(/--pm expects one of/);
  });

  it("rejects unknown options and a second directory", () => {
    expect(() => parseArgs(["a", "--nope"])).toThrow(/Unknown option: --nope/);
    expect(() => parseArgs(["a", "b"])).toThrow(/Unexpected argument: b/);
  });

  it("accepts --link-workspace, --force and -y", () => {
    const options = parseArgs(["a", "--link-workspace", "--force", "-y"]);

    expect(options.linkWorkspace).toBe(true);
    expect(options.force).toBe(true);
    expect(options.yes).toBe(true);
  });

  it("allows the directory to be omitted", () => {
    expect(parseArgs(["--yes"]).directory).toBeUndefined();
  });
});

describe("toProjectName", () => {
  it("passes a already-valid name through", () => {
    expect(toProjectName("my-app")).toBe("my-app");
  });

  it("normalises characters npm would reject", () => {
    expect(toProjectName("My App")).toBe("my-app");
    expect(toProjectName("Weird!!Name")).toBe("weird-name");
    expect(toProjectName("_leading")).toBe("leading");
    expect(toProjectName("trailing-")).toBe("trailing");
  });

  it("falls back when nothing usable is left", () => {
    expect(toProjectName("---")).toBe("mahi-app");
    expect(toProjectName("")).toBe("mahi-app");
  });

  it("always produces a name npm accepts", () => {
    for (const input of ["My App", "Weird!!Name", "_leading", "---", "", "UPPER"]) {
      expect(isValidProjectName(toProjectName(input))).toBe(true);
    }
  });
});

describe("isValidProjectName", () => {
  it("accepts lowercase names with dots, dashes and underscores", () => {
    expect(isValidProjectName("my-app")).toBe(true);
    expect(isValidProjectName("my.app_1")).toBe(true);
  });

  it("rejects uppercase, leading punctuation and over-long names", () => {
    expect(isValidProjectName("MyApp")).toBe(false);
    expect(isValidProjectName("-app")).toBe(false);
    expect(isValidProjectName("a".repeat(215))).toBe(false);
  });
});

describe("package manager detection", () => {
  it("reads the name out of npm_config_user_agent", () => {
    expect(detectPackageManager("pnpm/9.15.0 node/v22.0.0 darwin arm64")).toBe("pnpm");
    expect(detectPackageManager("yarn/4.0.0 node/v22.0.0")).toBe("yarn");
    expect(detectPackageManager("bun/1.1.0")).toBe("bun");
  });

  it("falls back to npm for an absent or unrecognised agent", () => {
    // Note `undefined` is NOT passed here: the parameter defaults to
    // `process.env.npm_config_user_agent`, so an explicit `undefined`
    // re-reads the ambient env rather than skipping detection.
    expect(detectPackageManager("")).toBe("npm");
    expect(detectPackageManager("cargo/1.0.0")).toBe("npm");
    expect(detectPackageManager("nonsense")).toBe("npm");
  });

  it("installs with the same subcommand everywhere", () => {
    expect(installCommand("npm")).toEqual(["npm", ["install"]]);
    expect(installCommand("pnpm")).toEqual(["pnpm", ["install"]]);
  });

  it("only npm needs `run` for a script", () => {
    expect(runScript("npm", "test")).toBe("npm run test");
    expect(runScript("pnpm", "test")).toBe("pnpm test");
  });
});
