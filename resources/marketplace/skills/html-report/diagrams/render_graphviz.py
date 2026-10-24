import subprocess
import tempfile
import os
import sys
import re


class GraphvizError(RuntimeError):
    pass


class GraphvizSyntaxError(GraphvizError):
    def __init__(self, message, errors=None):
        super().__init__(message)
        self.errors = errors or []


def _parse_stderr(stderr_text):
    syntax_errors = []
    for line in stderr_text.splitlines():
        line = line.strip()
        if not line:
            continue
        m = re.match(r"^Error: (.+?) in line (\d+)", line)
        if m:
            syntax_errors.append({"line": int(m.group(2)), "message": m.group(1)})
            continue
        m = re.match(r"^Error: (.+)", line)
        if m:
            syntax_errors.append({"line": None, "message": m.group(1)})
            continue
        m = re.match(r"^Warning: (.+)", line)
        if m:
            continue
        if "syntax error" in line.lower():
            syntax_errors.append({"line": None, "message": line})
    return syntax_errors


def render_graphviz(dot_code, output_path, layout='dot',
                    max_width_in=None, max_height_in=None, dpi=150):
    out_dir = os.path.dirname(output_path) or '.'
    os.makedirs(out_dir, exist_ok=True)

    if max_width_in and max_height_in:
        size_attr = f'    size="{max_width_in:.2f},{max_height_in:.2f}!"\n    ratio="compress"\n'
        if 'digraph' in dot_code:
            dot_code = dot_code.replace('digraph {', f'digraph {{\n{size_attr}', 1)
        elif 'graph' in dot_code:
            dot_code = dot_code.replace('graph {', f'graph {{\n{size_attr}', 1)

    with tempfile.NamedTemporaryFile(mode='w', suffix='.dot', delete=False, dir=out_dir) as f:
        f.write(dot_code)
        dot_path = f.name

    try:
        cmd = [layout, '-Tpng', f'-Gdpi={dpi}', dot_path, '-o', output_path]
        result = subprocess.run(cmd, capture_output=True, timeout=30)
        stderr_text = result.stderr.decode(errors='replace')
        stdout_text = result.stdout.decode(errors='replace')

        if result.returncode != 0:
            syntax_errors = _parse_stderr(stderr_text)
            if syntax_errors:
                detail = "\n".join(
                    f"  Line {e['line']}: {e['message']}" if e['line']
                    else f"  {e['message']}"
                    for e in syntax_errors
                )
                raise GraphvizSyntaxError(
                    f"Graphviz syntax error (exit {result.returncode}):\n{detail}\n"
                    f"--- dot source ({len(dot_code)} chars) ---\n{dot_code[:2000]}",
                    errors=syntax_errors,
                )
            raise GraphvizError(
                f"Graphviz failed (exit {result.returncode}):\n"
                f"stderr: {stderr_text}\nstdout: {stdout_text}"
            )

        if not os.path.exists(output_path):
            raise GraphvizError(
                f"Graphviz returned 0 but no image produced.\n"
                f"stderr: {stderr_text}\nstdout: {stdout_text}"
            )

        return output_path

    finally:
        if os.path.exists(dot_path):
            os.unlink(dot_path)


GRAPHVIZ_DPI = 150


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: render_graphviz.py <dot_file> <output_png> [--layout ENGINE] [--dpi N] [--max-width IN] [--max-height IN]")
        sys.exit(1)
    dot_file = sys.argv[1]
    output_png = sys.argv[2]
    layout_engine = 'dot'
    dpi_val = GRAPHVIZ_DPI
    mw = None
    mh = None
    args = sys.argv[3:]
    i = 0
    while i < len(args):
        if args[i] == '--layout' and i + 1 < len(args):
            layout_engine = args[i + 1]
            i += 2
        elif args[i] == '--dpi' and i + 1 < len(args):
            dpi_val = int(args[i + 1])
            i += 2
        elif args[i] == '--max-width' and i + 1 < len(args):
            mw = float(args[i + 1])
            i += 2
        elif args[i] == '--max-height' and i + 1 < len(args):
            mh = float(args[i + 1])
            i += 2
        else:
            i += 1
    with open(dot_file, 'r', encoding='utf-8') as fh:
        code = fh.read()
    try:
        render_graphviz(code, output_png, layout=layout_engine,
                        max_width_in=mw, max_height_in=mh, dpi=dpi_val)
        print(f"OK: {output_png}")
    except GraphvizSyntaxError as e:
        print(f"SYNTAX ERROR: {e}", file=sys.stderr)
        sys.exit(2)
    except GraphvizError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
