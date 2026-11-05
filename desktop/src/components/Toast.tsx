import "./Toast.css";

/** 右上角轻提示（一次性结果反馈，自动消失，不需要交互） */
export function Toast({ text }: { text: string }) {
  return (
    <div className="mc-toast" role="status">
      {text}
    </div>
  );
}
