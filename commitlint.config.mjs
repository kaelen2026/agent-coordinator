/**
 * Conventional Commits 约束（配合 .husky/commit-msg 在提交时校验）。
 * 与 .claude/rules/git.md 对齐：commit message 要说清"为什么"，允许中文正文。
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "refactor",
        "perf",
        "test",
        "docs",
        "style",
        "build",
        "ci",
        "chore",
        "revert",
      ],
    ],
    // 中文/大写开头的 subject 都放行，只保留"不能为空、不加句号"的底线
    "subject-case": [0],
    // 中文正文按字符数很容易超过默认 100，不做硬限制
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
    "header-max-length": [2, "always", 100],
  },
};
