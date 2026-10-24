import subprocess
import tempfile
import os
import sys
import re


class PlantUMLError(RuntimeError):
    pass


class PlantUMLSyntaxError(PlantUMLError):
    def __init__(self, message, errors=None):
        super().__init__(message)
        self.errors = errors or []


def _parse_stderr(stderr_text):
    syntax_errors = []
    for line in stderr_text.splitlines():
        line = line.strip()
        if not line:
            continue
        m = re.match(r"^Error line (\d+) in file .+?: (.+)", line)
        if m:
            syntax_errors.append({"line": int(m.group(1)), "message": m.group(2)})
            continue
        m = re.match(r"^Syntax Error\?$", line, re.IGNORECASE)
        if m:
            syntax_errors.append({"line": None, "message": "Syntax Error"})
    return syntax_errors


def render_plantuml(puml_code, output_path, dpi=None, retries=1):
    out_dir = os.path.dirname(output_path) or '.'
    os.makedirs(out_dir, exist_ok=True)

    for attempt in range(1, retries + 2):
        with tempfile.NamedTemporaryFile(
            mode='w', suffix='.puml', delete=False, dir=out_dir
        ) as f:
            f.write(puml_code)
            puml_path = f.name

        try:
            cmd = ['plantuml', '-tpng', '-charset', 'UTF-8']
            if dpi and not _is_gantt(puml_code):
                cmd += [f'-Sdpi={dpi}']
            cmd.append(puml_path)

            result = subprocess.run(cmd, capture_output=True, timeout=60)
            generated = puml_path.rsplit('.', 1)[0] + '.png'
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
                    raise PlantUMLSyntaxError(
                        f"PlantUML syntax error (exit {result.returncode}):\n{detail}\n"
                        f"--- puml source ({len(puml_code)} chars) ---\n{puml_code[:2000]}",
                        errors=syntax_errors,
                    )
                raise PlantUMLError(
                    f"PlantUML failed (exit {result.returncode}):\n"
                    f"stderr: {stderr_text}\nstdout: {stdout_text}"
                )

            if not os.path.exists(generated):
                if attempt <= retries:
                    continue
                raise PlantUMLError(
                    f"PlantUML returned 0 but no image produced.\n"
                    f"stderr: {stderr_text}\nstdout: {stdout_text}"
                )

            if generated != output_path:
                os.replace(generated, output_path)
            return output_path

        finally:
            if os.path.exists(puml_path):
                os.unlink(puml_path)

    raise PlantUMLError("render_plantuml: exhausted retries without producing an image")


def _is_gantt(code):
    return '@startgantt' in code


PLANTUML_THEME = """
skinparam defaultFontName "Noto Sans CJK SC"
skinparam defaultFontSize 14
skinparam shadowing false
skinparam roundCorner 10
skinparam participant {
    BackgroundColor #BBDEFB
    BorderColor #1976D2
    FontColor #1a365d
}
skinparam actor {
    BackgroundColor #BBDEFB
    BorderColor #1976D2
}
skinparam database {
    BackgroundColor #FFE0B2
    BorderColor #F57C00
}
skinparam collections {
    BackgroundColor #E1BEE7
    BorderColor #7B1FA2
}
skinparam rectangle {
    BackgroundColor #E8F4FD
    BorderColor #2b6cb0
    RoundCorner 10
}
skinparam arrow {
    Color #2b6cb0
    FontColor #2d3748
}
skinparam note {
    BackgroundColor #FFF9C4
    BorderColor #F9A825
}
skinparam activity {
    BackgroundColor #C8E6C9
    BorderColor #388E3C
    StartColor #388E3C
    EndColor #D32F2F
    DiamondBackgroundColor #FFF9C4
    DiamondBorderColor #F9A825
}
"""


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: render_plantuml.py <puml_file> <output_png> [--dpi N]")
        sys.exit(1)
    puml_file = sys.argv[1]
    output_png = sys.argv[2]
    dpi_val = None
    if '--dpi' in sys.argv:
        idx = sys.argv.index('--dpi')
        if idx + 1 < len(sys.argv):
            dpi_val = int(sys.argv[idx + 1])
    with open(puml_file, 'r', encoding='utf-8') as fh:
        code = fh.read()
    try:
        render_plantuml(code, output_png, dpi=dpi_val)
        print(f"OK: {output_png}")
    except PlantUMLSyntaxError as e:
        print(f"SYNTAX ERROR: {e}", file=sys.stderr)
        sys.exit(2)
    except PlantUMLError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
