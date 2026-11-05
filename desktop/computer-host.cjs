/**
 * 电脑控制桥（主进程）：agent 的 computer_* 工具通过本地 HTTP 调这里。
 *
 * 链路：agent server(子进程) --HTTP(token)--> 本桥 --stdin 行JSON--> PowerShell 助手
 *                                                        └--Electron desktopCapturer 截图（不走助手）
 *
 * 结构 1:1 仿 browser-host.cjs：只监听 127.0.0.1 随机端口 + token 头校验。
 * - 截图：desktopCapturer（显式物理分辨率 thumbnailSize + display_id 匹配 + nativeImage 缩图）
 * - 输入/窗口/剪贴板：常驻 PowerShell 助手（SendInput/EnumWindows/Clipboard，PER_MONITOR_AWARE_V2，
 *   坐标一律物理像素；UI-TARS 同款「剪贴板 + CtrlV」打字方案，规避合成键入的 Unicode/IME 问题）
 */
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { desktopCapturer, screen, nativeImage } = require("electron");

const OP_TIMEOUT_MS = 30_000;
const HELPER_TIMEOUT_MS = 15_000;
const SCREENSHOT_MAX_WIDTH = 1280;
/** base64 上限 ~2.5MB，防止超大截图打爆 HTTP */
const SCREENSHOT_MAX_BASE64 = 2_500_000;
const WINDOW_LIST_MAX = 60;

const ALLOWED_REMOTE = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * 常驻 PowerShell 助手脚本（保持纯 ASCII，5.1 语法，无 ${ 以免与 JS 模板串冲突）。
 * stdin 每行一个 JSON 请求（{id, op, ...}），stdout 每行一个 JSON 回复（回带 id）。
 */
const HELPER_PS = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class MeowInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion u; }

  public const uint MOVE = 0x0001;
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
  public const uint RIGHTDOWN = 0x0008;
  public const uint RIGHTUP = 0x0010;
  public const uint MIDDLEDOWN = 0x0020;
  public const uint MIDDLEUP = 0x0040;
  public const uint WHEEL = 0x0800;
  public const uint HWHEEL = 0x1000;
  public const uint KEYUP = 0x0002;
  public const uint INPUT_MOUSE = 0;
  public const uint INPUT_KEYBOARD = 1;

  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")]
  public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")]
  public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int cmd);

  public static void Mouse(uint flags, int wheel) {
    var arr = new INPUT[1];
    arr[0].type = INPUT_MOUSE;
    arr[0].u.mi.dwFlags = flags;
    arr[0].u.mi.mouseData = (uint)wheel;
    if (SendInput(1, arr, Marshal.SizeOf(typeof(INPUT))) == 0) throw new Exception("SendInput failed");
  }

  public static void Key(ushort vk, bool up) {
    var arr = new INPUT[1];
    arr[0].type = INPUT_KEYBOARD;
    arr[0].u.ki.wVk = vk;
    if (up) arr[0].u.ki.dwFlags = KEYUP;
    if (SendInput(1, arr, Marshal.SizeOf(typeof(INPUT))) == 0) throw new Exception("SendInput failed");
  }

  public static List<long> ListWindows() {
    var result = new List<long>();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      if (!IsWindowVisible(hWnd) || IsIconic(hWnd)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(hWnd, sb, 512);
      if (sb.ToString().Trim().Length == 0) return true;
      result.Add(hWnd.ToInt64());
      return true;
    }, IntPtr.Zero);
    return result;
  }

  public static string WindowTitle(IntPtr hWnd) {
    var sb = new StringBuilder(512);
    GetWindowText(hWnd, sb, 512);
    return sb.ToString().Trim();
  }

  public static uint ProcessOf(IntPtr hWnd) {
    uint pid;
    GetWindowThreadProcessId(hWnd, out pid);
    return pid;
  }

  public static bool Activate(IntPtr hWnd) {
    var fg = GetForegroundWindow();
    if (fg == hWnd) return true;
    uint fgPid;
    var fgThread = GetWindowThreadProcessId(fg, out fgPid);
    var thisThread = GetCurrentThreadId();
    uint targetPid;
    var targetThread = GetWindowThreadProcessId(hWnd, out targetPid);
    AttachThreadInput(thisThread, fgThread, true);
    AttachThreadInput(thisThread, targetThread, true);
    try {
      ShowWindow(hWnd, 9);
      return SetForegroundWindow(hWnd);
    } finally {
      AttachThreadInput(thisThread, fgThread, false);
      AttachThreadInput(thisThread, targetThread, false);
    }
  }
}
'@

[void][MeowInput]::SetProcessDpiAwarenessContext([IntPtr](-4))
Add-Type -AssemblyName System.Windows.Forms | Out-Null

$VK = @{}
$VK['space'] = 0x20; $VK['return'] = 0x0D; $VK['enter'] = 0x0D; $VK['tab'] = 0x09
$VK['escape'] = 0x1B; $VK['esc'] = 0x1B; $VK['backspace'] = 0x08
$VK['delete'] = 0x2E; $VK['del'] = 0x2E; $VK['insert'] = 0x2D; $VK['ins'] = 0x2D
$VK['home'] = 0x24; $VK['end'] = 0x23; $VK['pageup'] = 0x21; $VK['pagedown'] = 0x22
$VK['up'] = 0x26; $VK['down'] = 0x28; $VK['left'] = 0x25; $VK['right'] = 0x27
$VK['ctrl'] = 0x11; $VK['control'] = 0x11; $VK['alt'] = 0x12; $VK['shift'] = 0x10
$VK['win'] = 0x5B; $VK['meta'] = 0x5B; $VK['cmd'] = 0x5B; $VK['menu'] = 0x5D
$VK['capslock'] = 0x14; $VK['printscreen'] = 0x2C
$VK['minus'] = 0xBD; $VK['equal'] = 0xBB; $VK['comma'] = 0xBC; $VK['period'] = 0xBE
$VK['slash'] = 0xBF; $VK['backslash'] = 0xDC; $VK['semicolon'] = 0xBA; $VK['quote'] = 0xDE
$VK['bracketleft'] = 0xDB; $VK['bracketright'] = 0xDD; $VK['grave'] = 0xC0
for ($i = 1; $i -le 12; $i++) { $VK[('f' + $i)] = 0x70 + $i - 1 }
for ($i = 0; $i -le 9; $i++) { $VK[[string]$i] = 0x30 + $i }
foreach ($c in 'abcdefghijklmnopqrstuvwxyz'.ToCharArray()) { $VK[[string]$c] = [int][char]$c - 32 }

function Send-KeyCombo([string]$combo) {
  $parts = $combo.Split('+') | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ }
  if (-not $parts) { throw 'empty key combo' }
  $vks = @()
  foreach ($p in @($parts)) {
    if (-not $VK.ContainsKey($p)) { throw ('unknown key: ' + $p) }
    $vks += [uint16]$VK[$p]
  }
  foreach ($vk in $vks) { [MeowInput]::Key($vk, $false) }
  for ($i = $vks.Count - 1; $i -ge 0; $i--) { [MeowInput]::Key($vks[$i], $true) }
}

function Send-Click([int]$x, [int]$y, [string]$button, [int]$clicks) {
  [void][MeowInput]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 60
  for ($i = 0; $i -lt $clicks; $i++) {
    if ($button -eq 'right') {
      [MeowInput]::Mouse([MeowInput]::RIGHTDOWN, 0); [MeowInput]::Mouse([MeowInput]::RIGHTUP, 0)
    } elseif ($button -eq 'middle') {
      [MeowInput]::Mouse([MeowInput]::MIDDLEDOWN, 0); [MeowInput]::Mouse([MeowInput]::MIDDLEUP, 0)
    } else {
      [MeowInput]::Mouse([MeowInput]::LEFTDOWN, 0); [MeowInput]::Mouse([MeowInput]::LEFTUP, 0)
    }
    Start-Sleep -Milliseconds 60
  }
}

function Send-Drag([int]$x1, [int]$y1, [int]$x2, [int]$y2, [string]$button) {
  [void][MeowInput]::SetCursorPos($x1, $y1)
  Start-Sleep -Milliseconds 80
  $down = [MeowInput]::LEFTDOWN; $up = [MeowInput]::LEFTUP
  if ($button -eq 'right') { $down = [MeowInput]::RIGHTDOWN; $up = [MeowInput]::RIGHTUP }
  elseif ($button -eq 'middle') { $down = [MeowInput]::MIDDLEDOWN; $up = [MeowInput]::MIDDLEUP }
  [MeowInput]::Mouse($down, 0)
  Start-Sleep -Milliseconds 90
  $steps = 14
  for ($i = 1; $i -le $steps; $i++) {
    $t = $i / $steps
    [void][MeowInput]::SetCursorPos([int]($x1 + ($x2 - $x1) * $t), [int]($y1 + ($y2 - $y1) * $t))
    Start-Sleep -Milliseconds 16
  }
  Start-Sleep -Milliseconds 60
  [MeowInput]::Mouse($up, 0)
}

function Send-Scroll([string]$dir, [int]$amount, $x, $y) {
  if ($null -ne $x -and $null -ne $y) {
    [void][MeowInput]::SetCursorPos([int]$x, [int]$y)
    Start-Sleep -Milliseconds 60
  }
  $notches = [Math]::Max(1, [Math]::Min(30, $amount))
  for ($i = 0; $i -lt $notches; $i++) {
    if ($dir -eq 'up') { [MeowInput]::Mouse([MeowInput]::WHEEL, 120) }
    elseif ($dir -eq 'down') { [MeowInput]::Mouse([MeowInput]::WHEEL, -120) }
    elseif ($dir -eq 'left') { [MeowInput]::Mouse([MeowInput]::HWHEEL, -120) }
    elseif ($dir -eq 'right') { [MeowInput]::Mouse([MeowInput]::HWHEEL, 120) }
    else { throw ('unknown scroll direction: ' + $dir) }
    Start-Sleep -Milliseconds 25
  }
}

function Send-Text([string]$text) {
  if (-not $text) { throw 'empty text' }
  $saved = [System.Windows.Forms.Clipboard]::GetText()
  [System.Windows.Forms.Clipboard]::SetText($text)
  Start-Sleep -Milliseconds 80
  Send-KeyCombo 'ctrl+v'
  Start-Sleep -Milliseconds 400
  if ($saved -and $saved -ne $text) {
    try { [System.Windows.Forms.Clipboard]::SetText($saved) } catch { }
  }
}

function List-Windows {
  $out = @()
  foreach ($h in [MeowInput]::ListWindows()) {
    if ($out.Count -ge 60) { break }
    $hwnd = [long]$h
    $title = [MeowInput]::WindowTitle([IntPtr]$hwnd)
    $proc = ''
    try { $proc = (Get-Process -Id ([int][MeowInput]::ProcessOf([IntPtr]$hwnd)) -ErrorAction Stop).ProcessName } catch { }
    $out += @{ hwnd = $hwnd; title = $title; process = $proc }
  }
  return ,$out
}

[Console]::Out.WriteLine('{"ok":true,"ready":true}')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = $null
  $resp = $null
  try {
    $req = $line | ConvertFrom-Json
    try { $id = [int]$req.id } catch { }
    switch ([string]$req.op) {
      'move' {
        [void][MeowInput]::SetCursorPos([int]$req.x, [int]$req.y)
        $resp = @{ ok = $true }
      }
      'click' {
        Send-Click ([int]$req.x) ([int]$req.y) ([string]$req.button) ([Math]::Max(1, [Math]::Min(3, [int]$req.clicks)))
        $resp = @{ ok = $true }
      }
      'drag' {
        Send-Drag ([int]$req.fromX) ([int]$req.fromY) ([int]$req.toX) ([int]$req.toY) ([string]$req.button)
        $resp = @{ ok = $true }
      }
      'scroll' {
        Send-Scroll ([string]$req.direction) ([int]$req.amount) $req.x $req.y
        $resp = @{ ok = $true }
      }
      'key' {
        Send-KeyCombo ([string]$req.key)
        $resp = @{ ok = $true }
      }
      'type' {
        Send-Text ([string]$req.text)
        $resp = @{ ok = $true }
      }
      'windows' {
        $resp = @{ ok = $true; windows = (List-Windows) }
      }
      'activate' {
        $activated = [MeowInput]::Activate([IntPtr][long]$req.hwnd)
        $resp = @{ ok = $true; activated = [bool]$activated }
      }
      'clipboard_get' {
        $resp = @{ ok = $true; text = [System.Windows.Forms.Clipboard]::GetText() }
      }
      'clipboard_set' {
        [System.Windows.Forms.Clipboard]::SetText([string]$req.text)
        $resp = @{ ok = $true }
      }
      default {
        $resp = @{ ok = $false; error = ('unknown op: ' + [string]$req.op) }
      }
    }
  } catch {
    $resp = @{ ok = $false; error = $_.Exception.Message }
  }
  if ($null -ne $id) { $resp.id = $id }
  [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}
`;

/** JSON.stringify 但把非 ASCII 全部转义成 \uXXXX：PowerShell 5.1 按系统码页读 stdin，转义后纯 ASCII 绝不失真 */
function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u0080-\uFFFF]/g, (ch) =>
    `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function createComputerHostController(options = {}) {
  const log = options.log || ((...args) => console.error("[computer-host]", ...args));
  const token = options.token || randomBytes(24).toString("hex");
  let server = null;
  let baseUrl = "";
  /** 常驻 PowerShell 助手：{ proc, ready, pending: Map<id, {resolve,reject,timer}>, buffer } */
  let helper = null;
  let helperStartPromise = null;
  let helperScriptFile = "";
  let requestSeq = 0;

  // ------------------------------------------------------------------
  // PowerShell 助手管理（懒启动 / 掉线自动重启 / 退出清理）
  // ------------------------------------------------------------------

  function killHelper() {
    if (helper) {
      try {
        helper.proc.kill();
      } catch {
        // 已退出
      }
      helper = null;
    }
    helperStartPromise = null;
  }

  function ensureHelper() {
    if (process.platform !== "win32") {
      return Promise.reject(new Error("电脑控制当前仅支持 Windows"));
    }
    if (helper && helper.ready) return Promise.resolve(helper);
    if (helperStartPromise) return helperStartPromise;
    helperStartPromise = new Promise((resolve, reject) => {
      try {
        require("node:fs").writeFileSync(helperScriptFile, HELPER_PS, "utf8");
      } catch (error) {
        helperStartPromise = null;
        reject(error);
        return;
      }
      let state;
      let settled = false;
      try {
        const proc = spawn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", helperScriptFile],
          { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
        );
        state = { proc, ready: false, pending: new Map(), buffer: "" };
        helper = state;
        proc.on("error", (error) => {
          if (helper === state) helper = null;
          helperStartPromise = null;
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
        proc.stderr.on("data", (chunk) => {
          const text = chunk.toString("utf8").trim();
          if (text) log("helper stderr:", text.slice(0, 300));
        });
        proc.stdout.on("data", (chunk) => {
          state.buffer += chunk.toString("utf8");
          let index;
          while ((index = state.buffer.indexOf("\n")) >= 0) {
            const line = state.buffer.slice(0, index).trim();
            state.buffer = state.buffer.slice(index + 1);
            if (!line) continue;
            let message;
            try {
              message = JSON.parse(line);
            } catch {
              continue;
            }
            if (message.ready) {
              state.ready = true;
              if (!settled) {
                settled = true;
                resolve(state);
              }
              continue;
            }
            const pending = state.pending.get(message.id);
            if (pending) {
              state.pending.delete(message.id);
              clearTimeout(pending.timer);
              pending.resolve(message);
            }
          }
        });
        proc.on("exit", () => {
          for (const pending of state.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error("PowerShell 助手已退出"));
          }
          state.pending.clear();
          if (helper === state) helper = null;
          helperStartPromise = null;
        });
        proc.stdin.write(HELPER_PS + "\n");
      } catch (error) {
        helperStartPromise = null;
        reject(error);
      }
    });
    return helperStartPromise;
  }

  function helperRequest(payload, timeoutMs = HELPER_TIMEOUT_MS) {
    return ensureHelper().then(
      (state) =>
        new Promise((resolve, reject) => {
          const id = ++requestSeq;
          const timer = setTimeout(() => {
            state.pending.delete(id);
            reject(new Error("PowerShell 助手响应超时"));
          }, timeoutMs);
          state.pending.set(id, {
            resolve: (message) => resolve(message),
            reject,
            timer,
          });
          try {
            state.proc.stdin.write(asciiJson({ id, ...payload }) + "\n");
          } catch (error) {
            state.pending.delete(id);
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }),
    );
  }

  // ------------------------------------------------------------------
  // 截图（Electron desktopCapturer，物理分辨率 + 显示器匹配）
  // ------------------------------------------------------------------

  async function screenshotOp(displayIndex) {
    const displays = screen.getAllDisplays();
    if (!displays.length) {
      return { ok: false, error: "没有可用的显示器" };
    }
    let target = screen.getPrimaryDisplay();
    if (Number.isInteger(displayIndex) && displayIndex >= 0 && displayIndex < displays.length) {
      target = displays[displayIndex];
    }
    const physicalWidth = Math.round(target.size.width * target.scaleFactor);
    const physicalHeight = Math.round(target.size.height * target.scaleFactor);
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: physicalWidth, height: physicalHeight },
    });
    const source = sources.find((item) => item.display_id === String(target.id)) ?? sources[0];
    if (!source) {
      return { ok: false, error: "截屏失败：拿不到显示器画面" };
    }
    let image = source.thumbnail;
    if (!image || image.isEmpty()) {
      return { ok: false, error: "截屏失败：画面为空" };
    }
    if (image.getSize().width > SCREENSHOT_MAX_WIDTH) {
      image = image.resize({ width: SCREENSHOT_MAX_WIDTH, quality: "good" });
    }
    let quality = 78;
    let jpeg = image.toJPEG(quality);
    while (jpeg.length > SCREENSHOT_MAX_BASE64 && quality > 42) {
      quality -= 14;
      jpeg = image.toJPEG(quality);
    }
    while (jpeg.length > SCREENSHOT_MAX_BASE64 && image.getSize().width > 800) {
      image = image.resize({ width: Math.round(image.getSize().width * 0.75), quality: "good" });
      quality = 70;
      jpeg = image.toJPEG(quality);
    }
    if (jpeg.length > SCREENSHOT_MAX_BASE64) {
      return { ok: false, error: "截图过大，缩图后仍超限" };
    }
    const size = image.getSize();
    return {
      ok: true,
      screenshotBase64: jpeg.toString("base64"),
      mimeType: "image/jpeg",
      screenshotWidth: size.width,
      screenshotHeight: size.height,
      physicalWidth,
      physicalHeight,
      /** 物理坐标原点（显示器边界的物理近似；主屏 = 0,0） */
      originX: Math.round(target.bounds.x * target.scaleFactor),
      originY: Math.round(target.bounds.y * target.scaleFactor),
      scaleFactor: target.scaleFactor,
      displayIndex: displays.indexOf(target),
      displayCount: displays.length,
    };
  }

  // ------------------------------------------------------------------
  // 命令分发
  // ------------------------------------------------------------------

  function intField(command, name) {
    const value = Number(command[name]);
    return Number.isFinite(value) ? Math.round(value) : undefined;
  }

  async function handleCommand(command) {
    if (!command || typeof command !== "object" || typeof command.op !== "string") {
      return { ok: false, error: "Invalid computer command" };
    }
    switch (command.op) {
      case "status":
        return {
          ok: true,
          platform: process.platform,
          helperRunning: Boolean(helper?.ready),
          displays: screen.getAllDisplays().map((display, index) => ({
            index,
            primary: display.id === screen.getPrimaryDisplay().id,
            width: Math.round(display.size.width * display.scaleFactor),
            height: Math.round(display.size.height * display.scaleFactor),
            scaleFactor: display.scaleFactor,
          })),
        };
      case "screenshot":
        return await screenshotOp(command.display);
      case "move":
      case "click":
      case "drag":
      case "scroll":
      case "key":
      case "type":
      case "windows":
      case "activate":
      case "clipboard_get":
      case "clipboard_set": {
        if (process.platform !== "win32") {
          return { ok: false, error: "电脑控制当前仅支持 Windows" };
        }
        const payload = { op: command.op };
        for (const key of ["x", "y", "fromX", "fromY", "toX", "toY", "button", "clicks", "direction", "amount", "key", "text", "hwnd"]) {
          if (command[key] !== undefined) payload[key] = command[key];
        }
        const result = await helperRequest(payload);
        if (!result || result.ok !== true) {
          return { ok: false, error: result?.error || "PowerShell 助手执行失败" };
        }
        return { ok: true, ...result };
      }
      default:
        return { ok: false, error: `Unsupported computer op: ${command.op}` };
    }
  }

  function start() {
    if (server) return Promise.resolve({ baseUrl, token });
    helperScriptFile = path.join(os.tmpdir(), `meow-computer-input-${process.pid}.ps1`);
    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        const respond = (status, body) => {
          const text = JSON.stringify(body);
          res.writeHead(status, {
            "content-type": "application/json; charset=utf-8",
            "content-length": Buffer.byteLength(text),
          });
          res.end(text);
        };
        const remote = req.socket.remoteAddress || "";
        if (!ALLOWED_REMOTE.has(remote)) {
          respond(403, { ok: false, error: "forbidden" });
          return;
        }
        if (req.method === "GET" && req.url === "/health") {
          respond(200, { ok: true });
          return;
        }
        if (req.method === "POST" && req.url === "/computer/command") {
          if (req.headers["x-meow-computer-token"] !== token) {
            respond(401, { ok: false, error: "invalid token" });
            return;
          }
          let raw = "";
          req.on("data", (chunk) => {
            raw += chunk;
            if (raw.length > 1_000_000) req.destroy();
          });
          req.on("end", async () => {
            let command;
            try {
              command = JSON.parse(raw || "{}");
            } catch {
              respond(400, { ok: false, error: "invalid JSON body" });
              return;
            }
            const run = handleCommand(command).catch((error) => ({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }));
            const guard = new Promise((resolveGuard) => {
              setTimeout(() => resolveGuard({ ok: false, error: "操作超时" }), OP_TIMEOUT_MS);
            });
            respond(200, await Promise.race([run, guard]));
          });
          return;
        }
        respond(404, { ok: false, error: "not found" });
      });
      server.on("error", (error) => {
        server = null;
        reject(error);
      });
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve({ baseUrl, token });
      });
    });
  }

  function stop() {
    killHelper();
    if (server) {
      try {
        server.close();
      } catch {
        // 已关闭
      }
      server = null;
      baseUrl = "";
    }
    if (helperScriptFile) {
      try {
        require("node:fs").unlinkSync(helperScriptFile);
      } catch {
        // 不存在则忽略
      }
      helperScriptFile = "";
    }
  }

  return {
    start,
    stop,
    handleCommand,
    get baseUrl() {
      return baseUrl;
    },
    get token() {
      return token;
    },
  };
}

module.exports = { createComputerHostController };
