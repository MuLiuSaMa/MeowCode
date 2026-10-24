import { LuSparkles } from "react-icons/lu";
import type { GitView } from "../../git/useGitView";
import "./git.css";

/** 提交框：暂存区有内容才能提交；Ctrl/Cmd+Enter 快捷提交，AI 按钮填充文案由用户确认。 */
export function CommitBox({ git }: { git: GitView }) {
  const staged = git.status?.staged.length ?? 0;
  const conflicts = git.status?.conflicted.length ?? 0;
  const blocked = conflicts > 0 || staged === 0 || git.busy !== null;
  const hint = conflicts
    ? `有 ${conflicts} 个冲突待解决，解决后才能提交`
    : staged === 0
      ? "暂存文件后即可提交"
      : `${staged} 个文件已暂存`;

  return (
    <div className="mc-git__commitbox">
      <textarea
        className="mc-git__commitinput"
        value={git.message}
        placeholder={staged ? "提交信息（Ctrl+Enter 提交）" : "先暂存文件再写提交信息"}
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
          title="根据已暂存的 diff 生成提交信息"
          disabled={staged === 0 || git.aiLoading || git.busy !== null}
          onClick={() => void git.generateMessage()}
        >
          <LuSparkles size={12} />
          {git.aiLoading ? "生成中…" : "AI 生成"}
        </button>
        <button
          type="button"
          className="mc-git__commitbtn"
          disabled={blocked || !git.message.trim()}
          onClick={() => void git.commit()}
        >
          {git.busy === "commit" ? "提交中…" : "提交"}
        </button>
      </div>
    </div>
  );
}
