; ============================================================================
; MeowCode - Inno Setup 安装脚本（纯中文界面）
;
; 输入：desktop\release\win-unpacked（electron-builder --dir 产物）
;   生成目录版：
;     pnpm build
;     pnpm --filter @meowcode/desktop exec electron-builder --win --x64 --dir
; 编译：
;     & "C:\Program Files\Inno Setup 7\ISCC.exe" installer.iss
; 产物：installer-output\MeowCode-<版本>-setup.exe
;
; 版本号读取打包后的 MeowCode.exe，不用在脚本里重复维护。
; ============================================================================

#define MyAppName "MeowCode"
#define MyAppVersion GetFileVersionString("desktop\release\win-unpacked\MeowCode.exe")
#define MyAppPublisher "MuLiuSaMa"
#define MyAppURL "https://github.com/MuLiuSaMa/MeowCode"
#define MyAppExeName "MeowCode.exe"
#define MyBuildDir "desktop\release\win-unpacked"

[Setup]
; 固定 GUID：升级安装时识别同一款应用，请勿随意改动。
AppId={{CB59A67A-92C4-497A-A89C-FFD645AB37B7}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}

; 安装到 Program Files 需要管理员权限；应用本体是 asInvoker，装好后正常启动不会提权。
; 如果想改成按用户安装（免 UAC），把 PrivilegesRequired 改成 lowest，
; {autopf} 会自动落到 %LocalAppData%\Programs。
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableWelcomePage=no
DisableFinishedPage=no
DirExistsWarning=yes

PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0

UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}

; 安装包自身图标与版本信息
SetupIconFile=resources\icon.ico
VersionInfoVersion={#MyAppVersion}
VersionInfoCopyright=Copyright © MuLiuSaMa
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} 安装程序

; 覆盖安装时自动请求关闭正在运行的程序（Restart Manager 按占用文件识别）。
CloseApplications=yes
CloseApplicationsFilter=*.*
RestartApplications=no

OutputDir=installer-output
OutputBaseFilename={#MyAppName}-{#MyAppVersion}-setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ShowLanguageDialog=no
LanguageDetectionMethod=uilanguage

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
; 桌面快捷方式默认勾选（Inno 没有 checked 标志，不勾选项才写 unchecked）。
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加快捷方式（可选）："

[Files]
; 整个 win-unpacked 原样打包（app.asar、app.asar.unpacked、resources\agent-server 等）。
Source: "{#MyBuildDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"

[Run]
; 安装完成页默认勾选“立即运行”。
; 应用清单是 asInvoker，而安装器以管理员运行：用 runasoriginaluser 以普通权限启动，
; 避免把 MeowCode 连同终端、agent 一起提权。
Filename: "{app}\{#MyAppExeName}"; Description: "立即运行 {#MyAppName}"; Flags: postinstall nowait skipifsilent runasoriginaluser

[UninstallDelete]
; 应用数据默认保留（%APPDATA%\MeowCode 与 MeowCode-location.json），方便重装恢复。
; 如需彻底清除，取消下面两行注释：
; Type: filesandordirs; Name: "{userappdata}\MeowCode"
; Type: files; Name: "{userappdata}\MeowCode-location.json"

[Code]
// 卸载前检查主程序是否在运行：被占用时 Inno 会静默跳过文件删除。
// 用 tasklist 而不是 AppMutex，因为 Electron 的单实例锁名不稳定，无法写死。
function IsAppRunning(): Boolean;
var
  ResultCode: Integer;
  TempFile: String;
  Lines: TArrayOfString;
  I: Integer;
begin
  Result := False;
  TempFile := ExpandConstant('{tmp}\meowcode-tasklist.txt');
  if Exec(ExpandConstant('{cmd}'), '/C tasklist /FI "IMAGENAME eq {#MyAppExeName}" /NH > "' + TempFile + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    if LoadStringsFromFile(TempFile, Lines) then
      for I := 0 to GetArrayLength(Lines) - 1 do
        if Pos('{#MyAppExeName}', Lines[I]) > 0 then
        begin
          Result := True;
          Break;
        end;
    DeleteFile(TempFile);
  end;
end;

function InitializeUninstall(): Boolean;
begin
  if IsAppRunning() then
  begin
    MsgBox('MeowCode 正在运行，请先退出程序后再卸载。' + #13#10#13#10 +
      '否则安装目录下的文件会被占用，卸载无法完成清理。', mbError, MB_OK);
    Result := False;
    Exit;
  end;
  Result := True;
end;
