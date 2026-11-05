import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write text via same-directory tmp + fsync + rename.
 * Windows antivirus/indexer can briefly lock the target; retry the rename a few times.
 * Directory fsync is intentionally skipped: it fails on Windows and is not portable.
 */
export async function writeTextAtomic(filePath: string, text: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const handle = await fs.open(tmpPath, "w");
  try {
    await handle.writeFile(text, "utf8");
    await handle.datasync();
  } finally {
    await handle.close();
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(tmpPath, filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform === "win32" && RETRYABLE_RENAME_CODES.has(code) && attempt < 5) {
        await delay(20 * (attempt + 1));
        continue;
      }
      await fs.unlink(tmpPath).catch(() => undefined);
      throw error;
    }
  }
}

/** Write JSON atomically (see writeTextAtomic for the durability strategy). */
export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: { pretty?: boolean } = {},
): Promise<void> {
  const text = options.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  await writeTextAtomic(filePath, text);
}

/** Read + parse JSON; returns undefined for ENOENT, throws for malformed content. */
export async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
