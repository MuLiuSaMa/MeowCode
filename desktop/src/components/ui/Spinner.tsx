import "./Spinner.css";

export function Spinner({ size = 22 }: { size?: number }) {
  return (
    <span
      className="mc-spinner"
      style={{ width: size, height: size, borderWidth: Math.max(2, Math.round(size / 9)) }}
      role="status"
      aria-label="Loading"
    />
  );
}
