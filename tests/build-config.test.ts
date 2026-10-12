import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.join(__dirname, "..");

/**
 * 防回归：tsconfig.main.json 曾经漏掉 src/preload，导致 dist/main/preload 不存在、
 * window.appApi 为 undefined、渲染层白屏——而 typecheck/单测/打包全部"通过"。
 * 这两个测试把该不变量钉死。
 */
describe("构建配置完整性（防白屏回归）", () => {
  it("tsconfig.main.json 必须编译 src/preload", () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.main.json"), "utf8"));
    expect(cfg.include).toContain("src/preload");
  });

  it("已构建时 dist/main/preload/index.js 必须存在", () => {
    // 未执行过 npm run build 时跳过（dist 不存在）
    if (!fs.existsSync(path.join(root, "dist", "main", "main", "index.js"))) return;
    expect(fs.existsSync(path.join(root, "dist", "main", "preload", "index.js"))).toBe(true);
  });

  it("主进程预加载路径与 rootDir/outDir 输出布局一致", () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.main.json"), "utf8"));
    expect(cfg.compilerOptions.rootDir).toBe("src");
    expect(cfg.compilerOptions.outDir).toBe("dist/main");
    // src/main/index.ts 位于 dist/main/main，经 ../preload 解析到 dist/main/preload
    const mainSrc = fs.readFileSync(path.join(root, "src", "main", "index.ts"), "utf8");
    expect(mainSrc).toContain('path.join(__dirname, "../preload/index.js")');
  });
});
