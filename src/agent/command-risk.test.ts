import { describe, expect, it } from "vitest";
import { assessCommandRisk } from "./command-risk";

describe("assessCommandRisk", () => {
  it.each([
    "diskpart",
    "format C: /fs:NTFS",
    "reg delete HKLM\\Software\\Foo /f",
    "bcdedit /set {default} safeboot minimal",
    "shutdown /s /t 0",
    "Restart-Computer -Force",
    "Clear-Disk -Number 0 -RemoveData",
    "vssadmin delete shadows /all /quiet",
    "Remove-Item C:\\ -Recurse -Force",
    "Remove-Item C:\\Windows -Recurse",
    "rd /s /q C:\\",
    "del /s /q C:\\*",
  ])("flags dangerous command: %s", (command) => {
    const risk = assessCommandRisk(command);
    expect(risk?.level).toBe("high");
    expect(risk?.reasons.length).toBeGreaterThan(0);
  });

  it.each([
    "git format-patch -1",
    "Get-Content .\\README.md",
    "Remove-Item .\\dist -Recurse -Force",
    "npm run build",
    "pnpm test",
    "git status",
  ])("does not flag safe command: %s", (command) => {
    expect(assessCommandRisk(command)).toBeUndefined();
  });

  it("ignores empty commands", () => {
    expect(assessCommandRisk("  ")).toBeUndefined();
  });
});
