import { open, type FileHandle } from "node:fs/promises";

/**
 * A JSON array on disk that is valid JSON after every append. Entries are written as they
 * happen rather than at the end of the run, so a crash or a killed container never loses
 * failures that were already recorded. Callers must await each append before the next.
 */
export class JsonArrayFile {
  private readonly handle: FileHandle;
  /** Byte offset where the next entry goes (just before the closing bracket). */
  private insertAt = 2;
  private entries = 0;

  private constructor(handle: FileHandle) {
    this.handle = handle;
  }

  static async create(path: string): Promise<JsonArrayFile> {
    const handle = await open(path, "w");
    await handle.write("[\n]\n");
    return new JsonArrayFile(handle);
  }

  get count(): number {
    return this.entries;
  }

  async append(entry: unknown): Promise<void> {
    const item = JSON.stringify(entry, null, 2).replace(/^/gm, "  ");
    const chunk = Buffer.from(`${this.entries === 0 ? "" : ",\n"}${item}`);
    const closing = Buffer.from("\n]\n");
    // Overwrite the old closing bracket with the new entry plus a fresh closing bracket.
    await this.handle.write(Buffer.concat([chunk, closing]), 0, chunk.length + closing.length, this.insertAt);
    this.insertAt += chunk.length;
    this.entries += 1;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}
