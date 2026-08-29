import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "./types.js";

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  workspacePath(agentId: string): string {
    return path.join(this.root, agentId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  async create(agent: Agent): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: false });
    await this.writeInstructions(agent);
    await writeFile(
      path.join(agent.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(agent.workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  // The exact bytes AGENTS.md should hold for this agent. Factored out so drift
  // can be detected by comparing against the file, rather than by re-deriving
  // the format somewhere else and slowly disagreeing with it.
  instructionsDocument(agent: Agent): string {
    return this.buildInstructions(agent);
  }

  // What the agent will actually read. Null when the file is missing, which is
  // itself drift: something removed the spec the agent is supposed to follow.
  async readInstructions(agent: Agent): Promise<string | null> {
    try {
      return await readFile(
        path.join(agent.workspacePath, "AGENTS.md"),
        "utf8",
      );
    } catch {
      return null;
    }
  }

  // AGENTS.md lives inside the workspace and the default sandbox is
  // workspace-write, so the agent can edit the instructions it is governed by.
  // Nothing else writes this file between runs, so any difference means someone
  // or something other than the platform changed it.
  async instructionsDrifted(agent: Agent): Promise<boolean> {
    const onDisk = await this.readInstructions(agent);
    return onDisk !== this.buildInstructions(agent);
  }

  async writeInstructions(agent: Agent): Promise<void> {
    await writeFile(
      path.join(agent.workspacePath, "AGENTS.md"),
      this.buildInstructions(agent),
      "utf8",
    );
  }

  private buildInstructions(agent: Agent): string {
    const content = [
      "# Platform-managed Agent instructions",
      "",
      "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
      "",
      "## Workspace rules",
      "",
      "- Work only inside this workspace unless the user explicitly requests otherwise.",
      "- Preserve existing user files and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "",
      "This file is regenerated when the Agent configuration is updated.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    return content;
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    await rename(agent.workspacePath, destination);
    return destination;
  }
}
