import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCli } from "../src/cli.ts";
import { ConfigError, INPUT_FILE, loadSettings } from "../src/config.ts";

describe("parseCli", () => {
  it("has three commands: success (the default), validation and failed", () => {
    assert.deepEqual(parseCli([]), { mode: "ingest", env: {} });
    assert.deepEqual(parseCli(["success"]), { mode: "ingest", env: {} });
    assert.deepEqual(parseCli(["success", "--force"]), { mode: "ingest", env: { SHC_FORCE: "true" } });
    assert.deepEqual(parseCli(["validation"]), { mode: "ingest", env: { SHC_DRY_RUN: "true" } });
    assert.deepEqual(parseCli(["failed"]), { mode: "retry", env: {} });
    assert.equal(parseCli(["--help"]).mode, "help");
    assert.equal(parseCli(["-h"]).mode, "help");
  });

  it("still accepts the older flags", () => {
    assert.deepEqual(parseCli(["--validate"]), parseCli(["validation"]));
    assert.deepEqual(parseCli(["--dry-run"]), parseCli(["validation"]));
    assert.deepEqual(parseCli(["--retry"]), parseCli(["failed"]));
    assert.deepEqual(parseCli(["--force"]), parseCli(["success", "--force"]));
  });

  for (const args of [["data/export.csv"], ["--input", "data/export.csv"], ["-i", "x.csv"]]) {
    it(`refuses to take the input file from the command line: ${args.join(" ")}`, () => {
      assert.throws(() => parseCli(args), (error: Error) => error instanceof ConfigError && /always data\/input\/patients\.csv/.test(error.message));
    });
  }

  it("tells failed where its file goes when one is given", () => {
    assert.throws(() => parseCli(["my_failures.json"]), /failed command does not take a file .* always reads data\/retry\/failed_records\.json/);
  });

  for (const args of [["failed", "--force"], ["validation", "--force"], ["success", "failed"], ["validation", "--retry"], ["sucess"], ["--unknown"]]) {
    it(`rejects ${args.join(" ")}`, () => {
      assert.throws(() => parseCli(args), ConfigError);
    });
  }
});

describe("fixed input file", () => {
  it("is always data/input/patients.csv in the application folder", () => {
    assert.match(INPUT_FILE, /\/data\/input\/patients\.csv$/);
    assert.equal(loadSettings({ SHC_DRY_RUN: "true" }).inputFile, INPUT_FILE);
  });

  it("cannot be moved with SHC_INPUT_FILE", () => {
    assert.throws(() => loadSettings({ SHC_DRY_RUN: "true", SHC_INPUT_FILE: "data/other.csv" }), /SHC_INPUT_FILE is not supported/);
  });
});
