import { useTranslation } from "react-i18next";
import { LuSparkles } from "react-icons/lu";
import type { GitView } from "../../git/useGitView";
import "./git.css";

/** 提交框：暂存区有内容才能提交；Ctrl/Cmd+Enter 快捷提交，AI 按钮填充文案由用户确认。 */
export function CommitBox({ git }: { git: GitView }) {
  const { t } = useTranslation("git");
  // 列表会被服务端截断，计数必须用真实总数
  const staged = git.status?.stagedCount ?? git.status?.staged.length ?? 0;
  const conflicts = git.status?.conflictedCount ?? git.status?.conflicted.length ?? 0;
  const blocked = conflicts > 0 || staged === 0 || git.busy !== null;
  const hint = conflicts
    ? t("commit.conflicts", { count: conflicts })
    : staged === 0
      ? t("commit.needsStaged")
      : t("commit.staged", { count: staged });

  return (
    <div className="mc-git__commitbox">
      <textarea
        className="mc-git__commitinput"
        value={git.message}
        placeholder={staged ? t("commit.placeholder") : t("commit.placeholderEmpty")}
        rows={3}
        onChange={(event) => git.setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            if (!blocked && git.message.trim()) void git.commit();
          }
        }}
      />
      <div className="mc-git__commitbar">
        <span className="mc-git__commithint" data-warn={conflicts > 0}>
          {hint}
        </span>
        <button
          type="button"
          className="mc-git__aibtn"
          title={t("commit.aiTitle")}
          disabled={staged === 0 || git.aiLoading || git.busy !== null}
          onClick={() => void git.generateMessage()}
        >
          <LuSparkles size={12} />
          {git.aiLoading ? t("commit.aiGenerating") : t("commit.aiGenerate")}
        </button>
        <button
          type="button"
          className="mc-git__commitbtn"
          disabled={blocked || !git.message.trim()}
          onClick={() => void git.commit()}
        >
          {git.busy === "commit" ? t("commit.committing") : t("commit.submit")}
        </button>
      </div>
    </div>
  );
}
