import { describe, expect, it } from "vitest";
import { classifySandboxDenial, type SandboxDenialInput } from "./denial.js";

function input(overrides: Partial<SandboxDenialInput>): SandboxDenialInput {
  return {
    exitCode: 1,
    output: "",
    command: "Set-Content out.txt hello",
    timedOut: false,
    aborted: false,
    ...overrides,
  };
}

describe("classifySandboxDenial", () => {
  it("recognizes the strong English signal", () => {
    const denial = classifySandboxDenial(
      input({ output: "Set-Content : Access is denied." }),
    );
    expect(denial?.kind).toBe("write_denied");
    expect(denial?.evidence).toContain("Access is denied");
  });

  it("recognizes the Chinese Windows signal", () => {
    expect(
      classifySandboxDenial(input({ output: "Set-Content : 拒绝访问。" }))?.kind,
    ).toBe("write_denied");
  });

  it("recognizes Win32 and .NET signals", () => {
    expect(
      classifySandboxDenial(input({ output: "error 0x80070005" }))?.kind,
    ).toBe("write_denied");
    expect(
      classifySandboxDenial(
        input({
          output:
            "UnauthorizedAccessException: Access to the path 'C:\\Users\\x\\out.txt' is denied.",
        }),
      )?.kind,
    ).toBe("write_denied");
  });

  it("classifies delete commands as delete_denied", () => {
    const denial = classifySandboxDenial(
      input({ command: "Remove-Item out.txt", output: "Remove-Item : Access is denied." }),
    );
    expect(denial?.kind).toBe("delete_denied");
  });

  it("does not escalate a bare permission denied from git/ssh", () => {
    const denial = classifySandboxDenial(
      input({ command: "git push", output: "fatal: Permission denied (publickey)." }),
    );
    expect(denial?.kind).toBe("unknown_denied");
  });

  it("treats a bare permission denied with write context as write_denied", () => {
    const denial = classifySandboxDenial(
      input({
        command: "Set-Content out.txt hello",
        output: "EPERM: operation not permitted, open 'C:\\x\\out.txt'",
      }),
    );
    expect(denial?.kind).toBe("write_denied");
  });

  it("ignores clean exits, runner failures, timeouts, aborts and spawn errors", () => {
    expect(classifySandboxDenial(input({ exitCode: 0, output: "Access is denied" }))).toBeUndefined();
    expect(
      classifySandboxDenial(
        input({ exitCode: 127, output: "meowcode-sandbox-run: koffi missing" }),
      ),
    ).toBeUndefined();
    expect(classifySandboxDenial(input({ timedOut: true, output: "Access is denied" }))).toBeUndefined();
    expect(classifySandboxDenial(input({ aborted: true, output: "Access is denied" }))).toBeUndefined();
    expect(
      classifySandboxDenial(
        input({ spawnError: "ENOENT", output: "Access is denied" }),
      ),
    ).toBeUndefined();
  });

  it("ignores unrelated failures", () => {
    expect(classifySandboxDenial(input({ output: "TypeError: boom" }))).toBeUndefined();
  });

  it("truncates evidence to 400 characters", () => {
    const denial = classifySandboxDenial(input({ output: `Access is denied ${"x".repeat(800)}` }));
    expect(denial?.evidence.length).toBe(400);
  });

  it("carries the writable roots through", () => {
    const denial = classifySandboxDenial(
      input({ output: "Access is denied", writableRoots: ["C:\\work"] }),
    );
    expect(denial?.writableRoots).toEqual(["C:\\work"]);
  });
});
