import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConfigError, DEFAULT_API_URL, describeSettings, loadSettings } from "../src/config.ts";
import { tempDir } from "./helpers.ts";

const withToken = { SHC_API_TOKEN: "token-123" };

describe("loadSettings", () => {
  it("uses the documented defaults", () => {
    const settings = loadSettings(withToken);
    assert.equal(settings.apiUrl, DEFAULT_API_URL);
    assert.equal(settings.batchSize, 100);
    assert.equal(settings.rateLimitPerSecond, 5);
    assert.equal(settings.maxRetries, 5);
    assert.equal(settings.dryRun, false);
  });

  it("refuses a batch size above the API's maximum of 100", () => {
    assert.throws(() => loadSettings({ ...withToken, SHC_BATCH_SIZE: "500" }), /SHC_BATCH_SIZE must be between 1 and 100/);
    assert.throws(() => loadSettings({ ...withToken, SHC_BATCH_SIZE: "ten" }), /whole number/);
  });

  it("refuses to send patient data over plain http unless explicitly allowed", () => {
    const http = { ...withToken, SHC_API_URL: "http://mock-api:8080/v1/patients" };
    assert.throws(() => loadSettings(http), /plain http/);
    assert.equal(loadSettings({ ...http, SHC_ALLOW_INSECURE_HTTP: "true" }).apiUrl, "http://mock-api:8080/v1/patients");
  });

  it("requires a token, except for a dry run", () => {
    assert.throws(() => loadSettings({}), ConfigError);
    assert.equal(loadSettings({ SHC_DRY_RUN: "true" }).apiToken, null);
  });

  it("reads the token from a mounted secret file", async () => {
    const path = join(await tempDir(), "token");
    await writeFile(path, "  from-a-file\n");
    assert.equal(loadSettings({ SHC_API_TOKEN_FILE: path }).apiToken, "from-a-file");
    assert.throws(() => loadSettings({ SHC_API_TOKEN_FILE: path, SHC_API_TOKEN: "x" }), /not both/);
    assert.throws(() => loadSettings({ SHC_API_TOKEN_FILE: join(path, "missing") }), /cannot be read/);
  });

  it("validates encodings, booleans and log levels", () => {
    assert.equal(loadSettings({ ...withToken, SHC_INPUT_ENCODING: "cp1252" }).inputEncoding, "windows-1252");
    assert.throws(() => loadSettings({ ...withToken, SHC_INPUT_ENCODING: "klingon" }), /not a supported encoding/);
    assert.throws(() => loadSettings({ ...withToken, SHC_DRY_RUN: "maybe" }), /true or false/);
    assert.throws(() => loadSettings({ ...withToken, SHC_LOG_LEVEL: "loud" }), /SHC_LOG_LEVEL/);
  });
});

describe("describeSettings", () => {
  it("never includes the token", () => {
    const described = JSON.stringify(describeSettings(loadSettings({ SHC_API_TOKEN: "super-secret-value" })));
    assert.ok(!described.includes("super-secret-value"));
    assert.match(described, /\[redacted\]/);
  });
});
