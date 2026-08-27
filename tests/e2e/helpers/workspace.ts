import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

async function filesBelow(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await filesBelow(fullPath)));
    if (entry.isFile()) output.push(fullPath);
  }
  return output;
}

export async function documentationFiles(workspacePath: string) {
  const files = await filesBelow(workspacePath);
  const documentation = files.filter((file) => /\.(?:md|html?)$/i.test(file));
  return Promise.all(
    documentation.map(async (file) => ({
      path: file,
      content: await readFile(file, "utf8"),
    })),
  );
}
