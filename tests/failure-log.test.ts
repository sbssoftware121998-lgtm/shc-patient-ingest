import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JsonArrayFile } from "../src/failure-log.ts";
import { tempDir } from "./helpers.ts";

describe("JsonArrayFile", () => {
  it("is valid JSON after every append, including non-ASCII text", async () => {
    const path = join(await tempDir(), "failed_records.json");
    const file = await JsonArrayFile.create(path);
    const read = async () => JSON.parse(await readFile(path, "utf8")) as unknown;

    assert.deepEqual(await read(), []);
    const entries = [{ id: 1, balance: "€300.00" }, { id: 2, name: "Zoë García-López" }, { id: 3, nested: { lines: [4, 9] } }];
    for (const [index, entry] of entries.entries()) {
      await file.append(entry);
      assert.deepEqual(await read(), entries.slice(0, index + 1));
    }
    assert.equal(file.count, 3);
    await file.close();
  });
});
