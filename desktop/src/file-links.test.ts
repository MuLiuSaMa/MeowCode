import { describe, expect, it } from "vitest";
import { inlineFileLabel, inlineFilePathOf } from "./file-links";

describe("inlineFilePathOf", () => {
  it("认识工作区相对路径并原样返回", () => {
    expect(inlineFilePathOf("desktop/src/file-types.ts")).toBe("desktop/src/file-types.ts");
    expect(inlineFilePathOf("src-tauri/src/optimization.rs")).toBe("src-tauri/src/optimization.rs");
    expect(inlineFilePathOf("island.css")).toBe("island.css");
    expect(inlineFilePathOf("package.json")).toBe("package.json");
    expect(inlineFilePathOf("README.md")).toBe("README.md");
  });

  it("去掉 ./ 前缀、统一反斜杠与重复斜杠", () => {
    expect(inlineFilePathOf("./src/App.tsx")).toBe("src/App.tsx");
    expect(inlineFilePathOf("src\\components\\App.tsx")).toBe("src/components/App.tsx");
    expect(inlineFilePathOf("src//components/App.tsx")).toBe("src/components/App.tsx");
  });

  it("按约定文件名识别没有扩展名的文件", () => {
    expect(inlineFilePathOf("Dockerfile")).toBe("Dockerfile");
    expect(inlineFilePathOf("Makefile")).toBe("Makefile");
    expect(inlineFilePathOf(".env.local")).toBe(".env.local");
    expect(inlineFilePathOf(".gitignore")).toBe(".gitignore");
  });

  it("命令 / 标识符 / 版本号留在代码样式里", () => {
    expect(inlineFilePathOf("pnpm typecheck")).toBeNull();
    expect(inlineFilePathOf("run_powercfg")).toBeNull();
    expect(inlineFilePathOf("v1.2.3")).toBeNull();
    expect(inlineFilePathOf("Array.prototype.map")).toBeNull();
    expect(inlineFilePathOf("socket.io")).toBeNull();
    expect(inlineFilePathOf("foo()")).toBeNull();
    expect(inlineFilePathOf("--no-verify")).toBeNull();
  });

  it("URL、行号、绝对路径和目录都不算", () => {
    expect(inlineFilePathOf("https://example.com/a.ts")).toBeNull();
    expect(inlineFilePathOf("src/a.ts:42")).toBeNull();
    expect(inlineFilePathOf("D:\\MeowCode\\src\\App.tsx")).toBeNull();
    expect(inlineFilePathOf("/etc/hosts")).toBeNull();
    expect(inlineFilePathOf("~/notes.md")).toBeNull();
    expect(inlineFilePathOf("src/components")).toBeNull();
    expect(inlineFilePathOf("src/")).toBeNull();
  });

  it("相对路径越界与空值不转换", () => {
    expect(inlineFilePathOf("../outside.ts")).toBeNull();
    expect(inlineFilePathOf("src/../a.ts")).toBeNull();
    expect(inlineFilePathOf("")).toBeNull();
    expect(inlineFilePathOf("   ")).toBeNull();
    expect(inlineFilePathOf(`src/${"a".repeat(220)}.ts`)).toBeNull();
  });
});

describe("inlineFileLabel", () => {
  it("只显示文件名", () => {
    expect(inlineFileLabel("desktop/src/island/IslandApp.tsx")).toBe("IslandApp.tsx");
    expect(inlineFileLabel("src-tauri\\src\\optimization.rs")).toBe("optimization.rs");
    expect(inlineFileLabel("README.md")).toBe("README.md");
  });
});