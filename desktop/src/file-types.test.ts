import { describe, expect, it } from "vitest";
import { extensionOf, fileNameOf, fileTypeOf } from "./file-types";

describe("fileNameOf", () => {
  it("取最后一段，兼容 / 与 \\ 两种分隔符", () => {
    expect(fileNameOf("src/island/IslandApp.tsx")).toBe("IslandApp.tsx");
    expect(fileNameOf("D:\\MeowCode\\desktop\\src\\island\\island.css")).toBe("island.css");
    expect(fileNameOf("island.css")).toBe("island.css");
  });
});

describe("extensionOf", () => {
  it("小写扩展名，不含点", () => {
    expect(extensionOf("IslandApp.TSX")).toBe("tsx");
    expect(extensionOf("a/b/c.tar.gz")).toBe("gz");
  });

  it("点开头的文件没有扩展名", () => {
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("src/.env.local")).toBe("local");
  });
});

describe("fileTypeOf", () => {
  it("按语法识别常见源码文件", () => {
    expect(fileTypeOf("island.css").key).toBe("css");
    expect(fileTypeOf("src/island/IslandApp.tsx").key).toBe("react");
    expect(fileTypeOf("src/island/main.tsx").key).toBe("react");
    expect(fileTypeOf("main.ts").key).toBe("typescript");
    expect(fileTypeOf("index.js").key).toBe("javascript");
    expect(fileTypeOf("index.html").key).toBe("html");
    expect(fileTypeOf("tsconfig.json").key).toBe("json");
    expect(fileTypeOf("README.md").key).toBe("markdown");
    expect(fileTypeOf("main.py").key).toBe("python");
    expect(fileTypeOf("main.rs").key).toBe("rust");
    expect(fileTypeOf("main.go").key).toBe("go");
  });

  it("扩展名大小写不敏感", () => {
    expect(fileTypeOf("IslandApp.TSX").key).toBe("react");
    expect(fileTypeOf("Island.CSS").key).toBe("css");
  });

  it("没有扩展名时按约定文件名识别", () => {
    expect(fileTypeOf("Dockerfile").key).toBe("docker");
    expect(fileTypeOf("docker/Dockerfile.dev").key).toBe("docker");
    expect(fileTypeOf("Makefile").key).toBe("make");
    expect(fileTypeOf("CMakeLists.txt").key).toBe("cmake");
    expect(fileTypeOf("desktop/.gitignore").key).toBe("git");
    expect(fileTypeOf(".env").key).toBe("env");
    expect(fileTypeOf(".env.production").key).toBe("env");
  });

  it("按分类识别媒体与办公文件", () => {
    expect(fileTypeOf("shot.png").key).toBe("image");
    expect(fileTypeOf("logo.svg").key).toBe("svg");
    expect(fileTypeOf("demo.mp4").key).toBe("video");
    expect(fileTypeOf("voice.mp3").key).toBe("audio");
    expect(fileTypeOf("report.pdf").key).toBe("pdf");
    expect(fileTypeOf("sheet.xlsx").key).toBe("spreadsheet");
    expect(fileTypeOf("bundle.zip").key).toBe("archive");
  });

  it("认不出的文件回落到通用文件类型并仍有颜色", () => {
    const type = fileTypeOf("model.unknownext");
    expect(type.key).toBe("file");
    expect(type.tint).not.toBe("");
  });

  it("每种语法类型都带颜色（FileIcon 直接把它注入 --file-tint）", () => {
    const samples = [
      "a.css",
      "a.tsx",
      "a.ts",
      "a.js",
      "a.json",
      "a.md",
      "a.yml",
      "a.toml",
      "a.html",
      "a.py",
      "a.rs",
      "a.go",
      "a.java",
      "a.png",
      "a.mp4",
      "a.mp3",
      "a.pdf",
      "a.zip",
      "a.exe",
      "Dockerfile",
      "unknown",
    ];
    for (const sample of samples) {
      expect(fileTypeOf(sample).tint).toMatch(/^(#[0-9a-f]{3,8}|var\(--[a-z-]+\))$/i);
    }
  });
});