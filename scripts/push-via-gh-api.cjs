/**
 * 用 GitHub Git Data API 把本地提交推上去（git push 因 DNS 失败时的备用通道）。
 *
 * 为什么需要它：本机 DNS 解析不了 github.com，git push 连不上；
 * 但 `gh` 走另一条网络路径可用。此脚本通过 gh api 建 blob/tree/commit 并更新 ref。
 *
 * 关键：message 必须由 Node 读原始 git 输出，不能经 PowerShell 序列化（会把多行拆成数组）。
 */
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = "libiucode/ai-";
const REPO_DIR = "D:/ai盯播工具/app";

function sh(cmd) {
  return execSync(cmd, { cwd: REPO_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
function ghApi(args, inputFile) {
  // 必须带 --jq .sha 之类取纯值；不带时 gh 返回整个 JSON 对象，
  // 直接塞进 tree 会被 GitHub 拒为 "not a valid blob"（实测踩到）。
  const cmd = inputFile
    ? `gh api ${args} --input "${inputFile}"`
    : `gh api ${args}`;
  const out = execSync(cmd, { cwd: REPO_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.trim();
}

async function main() {
  const localSha = sh("git rev-parse HEAD").trim();
  const baseSha = ghApi(`repos/${REPO}/git/ref/heads/main --jq .object.sha`);
  if (localSha === baseSha) { console.log("远端已同步"); process.exit(0); }
  console.log("本地 =", localSha);
  console.log("远端 =", baseSha);

  // 要推的提交（假定是单提交，或取 base..HEAD 里最新一个）
  const changed = sh(`git diff --name-only ${baseSha} ${localSha}`).split(/\r?\n/).filter(Boolean);
  console.log("改动文件数 =", changed.length);

  const baseTree = ghApi(`repos/${REPO}/git/commits/${baseSha} --jq .tree.sha`);
  const entries = [];
  for (const f of changed) {
    // 用 git show 取该提交版本的内容（保证与提交一致，不受工作区影响）
    const buf = execSync(`git show ${localSha}:${f}`, { cwd: REPO_DIR, maxBuffer: 64 * 1024 * 1024 });
    const payload = { content: buf.toString("base64"), encoding: "base64" };
    const tmp = path.join(os.tmpdir(), `blob-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
    const sha = ghApi(`repos/${REPO}/git/blobs --jq .sha`, tmp);
    fs.unlinkSync(tmp);
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`blob sha 非法: ${sha.slice(0, 120)}`);
    entries.push({ path: f, mode: "100644", type: "blob", sha });
    console.log(`  blob ${f} -> ${sha.slice(0, 8)}`);
  }

  const treeTmp = path.join(os.tmpdir(), "tree-push.json");
  fs.writeFileSync(treeTmp, JSON.stringify({ base_tree: baseTree, tree: entries }), "utf8");
  const newTree = ghApi(`repos/${REPO}/git/trees --jq .sha`, treeTmp);
  fs.unlinkSync(treeTmp);
  console.log("new tree =", newTree);

  // 从 commit 对象的原文里取 message，**不能用 `git log --format=%B`**：
  // 后者会多带一个尾部换行（实测：format=%B 长 1848，commit 对象里长 1847），
  // 导致 GitHub 算出的 commit SHA 与本地不一致。这里用 cat-file 取原始对象。
  const rawCommit = sh(`git cat-file commit ${localSha}`);
  const sepIdx = rawCommit.indexOf("\n\n");
  const msg = rawCommit.slice(sepIdx + 2);
  const authorName = sh(`git log -1 --format=%an ${localSha}`).trim();
  const authorEmail = sh(`git log -1 --format=%ae ${localSha}`).trim();
  const authorDate = sh(`git log -1 --format=%aI ${localSha}`).trim();

  const commitTmp = path.join(os.tmpdir(), "commit-push.json");
  fs.writeFileSync(
    commitTmp,
    JSON.stringify({
      message: msg, // ← 原始多行字符串，不经 PowerShell
      tree: newTree,
      parents: [baseSha],
      author: { name: authorName, email: authorEmail, date: authorDate },
    }),
    "utf8",
  );
  const newCommit = ghApi(`repos/${REPO}/git/commits --jq .sha`, commitTmp);
  fs.unlinkSync(commitTmp);
  console.log("new commit =", newCommit);
  console.log("本地 commit =", localSha);
  console.log("一致?", newCommit === localSha);

  if (newCommit !== localSha) {
    // 不一致说明 tree/author/message 有偏差，此时**不要**更新远端 ref，
    // 否则会把一个与本地不同的提交写上去，破坏「本地 = 远端」的可核对性。
    console.log("!! 提交 SHA 与本地不一致，已中止，不更新远端 ref");
    process.exit(1);
  }

  // 更新 ref
  const refTmp = path.join(os.tmpdir(), "ref-push.json");
  fs.writeFileSync(refTmp, JSON.stringify({ sha: newCommit, force: false }), "utf8");
  const res = ghApi(`repos/${REPO}/git/refs/heads/main -X PATCH --jq .object.sha`, refTmp);
  fs.unlinkSync(refTmp);
  console.log("ref 更新结果:", res.includes(newCommit) ? "成功" : res.slice(0, 200));
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  if (e.stdout) console.error(String(e.stdout).slice(0, 500));
  process.exit(1);
});
