<#
MeowCode MSIX 本地测试签名 / 侧载安装。

商店提交不需要这一步（Partner Center 入库时会重签）。这里只解决本地安装：
 1. 自签名证书的 Subject 必须与包清单的 Publisher 完全一致；
 2. 证书要被当前用户信任（TrustedPeople + Root）；
 3. signtool 签名后用 Add-AppxPackage 安装。

用法（只影响当前用户，不需要管理员）：
  pnpm test:msix              # 签名 + 信任证书 + 安装 + 启动
  pnpm test:msix:sign         # 只签名（不动证书信任）
  pnpm test:msix:uninstall    # 卸载并移除本脚本创建的证书

注意：重新运行 pnpm package:msix 会生成未签名的新包，需要再跑一次签名。
上传商店用未签名包即可（Partner Center 会重签）。
#>
param(
  [string]$Package = "",
  [switch]$NoInstall,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
# Git Bash 等非 PowerShell 终端里也能正常显示中文
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$root = Split-Path -Parent $PSScriptRoot

if (-not $Package) {
  $Package = Get-ChildItem -Path (Join-Path $root "desktop\release\*.msix") -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Package -or -not (Test-Path -LiteralPath $Package)) {
  throw "找不到 MSIX。先运行 pnpm package:msix 生成 desktop\release\*.msix"
}

# ---------- 读包清单 ----------
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($Package)
try {
  $entry = $zip.Entries | Where-Object { $_.FullName -eq "AppxManifest.xml" } | Select-Object -First 1
  if (-not $entry) { throw "MSIX 内没有 AppxManifest.xml" }
  $reader = New-Object System.IO.StreamReader($entry.Open())
  try { [xml]$manifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
} finally {
  $zip.Dispose()
}
$identityName = [string]$manifest.Package.Identity.Name
$publisher = [string]$manifest.Package.Identity.Publisher
$appId = [string](@($manifest.Package.Applications.Application)[0].Id)
Write-Host "[msix-test] 包身份: $identityName"
Write-Host "[msix-test] 发布者: $publisher"

# ---------- 卸载 ----------
if ($Uninstall) {
  $installed = Get-AppxPackage -Name $identityName -ErrorAction SilentlyContinue
  if ($installed) {
    Remove-AppxPackage -Package $installed.PackageFullName
    Write-Host "[msix-test] 已卸载 $($installed.PackageFullName)"
  }
  # 只清理本脚本自己创建的证书：按签名时写下的指纹标记删除。
  # 用户可能已经有一张同 Subject 的证书（同一发布者的其他产品），绝不能误删。
  $marker = Join-Path $root "desktop\release\msix-test-sign\created-cert.txt"
  if (Test-Path -LiteralPath $marker) {
    $thumbprint = (Get-Content -LiteralPath $marker -Raw).Trim()
    foreach ($store in @("TrustedPeople", "Root")) {
      Get-ChildItem "Cert:\CurrentUser\$store" |
        Where-Object { $_.Thumbprint -eq $thumbprint } |
        Remove-Item -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -Path ("Cert:\CurrentUser\My\" + $thumbprint) -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    Write-Host "[msix-test] 已移除自建测试证书 $thumbprint"
  }
  return
}

# ---------- 证书（Subject 与 Publisher 逐字节一致） ----------
$outDir = Join-Path $root "desktop\release\msix-test-sign"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$cerPath = Join-Path $outDir "MeowCode-test.cer"
$pfxPath = Join-Path $outDir "MeowCode-test.pfx"

$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object {
  $_.Subject -eq $publisher -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date)
} | Sort-Object NotAfter -Descending | Select-Object -First 1

$created = $false
if (-not $cert) {
  Write-Host "[msix-test] 创建自签名代码签名证书（当前用户，3 年有效）"
  $cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $publisher `
    -KeyUsage DigitalSignature `
    -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddYears(3) `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -FriendlyName "MeowCode MSIX test signing"
  $created = $true
} else {
  Write-Host "[msix-test] 复用已存在的同发布者证书: $($cert.FriendlyName)"
}
if ($created) {
  Set-Content -LiteralPath (Join-Path $outDir "created-cert.txt") -Value $cert.Thumbprint -NoNewline
}

# 每次从证书导出 pfx/cer：保证签名用的私钥与清单 Publisher 一致
$password = [guid]::NewGuid().ToString("N")
$secure = ConvertTo-SecureString -String $password -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $secure -Force | Out-Null
Export-Certificate -Cert $cert -FilePath $cerPath -Force | Out-Null
Write-Host "[msix-test] 证书指纹: $($cert.Thumbprint)"

# ---------- 签名 ----------
$signtool = (Get-Command signtool.exe -ErrorAction SilentlyContinue).Source
if (-not $signtool) {
  $signtool = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $signtool) {
  throw "找不到 signtool.exe：安装 Windows SDK 后重试（winget install Microsoft.WindowsSDK.10.0.26100）"
}
& $signtool sign /fd SHA256 /f $pfxPath /p $password $Package
if ($LASTEXITCODE -ne 0) { throw "signtool 签名失败（exit $LASTEXITCODE）" }
Write-Host "[msix-test] 已签名: $Package"

if ($NoInstall) {
  Write-Host "[msix-test] -NoInstall：跳过证书信任与安装（侧载时去掉该参数重跑）。"
  return
}

# ---------- 信任 + 安装 ----------
foreach ($store in @("TrustedPeople", "Root")) {
  $target = "Cert:\CurrentUser\$store"
  $exists = Get-ChildItem $target | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
  if (-not $exists) {
    Import-Certificate -FilePath $cerPath -CertStoreLocation $target | Out-Null
    Write-Host "[msix-test] 测试证书已加入 $store（当前用户）"
  }
}

try {
  Add-AppxPackage -Path $Package -ForceUpdateFromAnyVersion
} catch {
  $message = $_.Exception.Message
  # 0x80073CFB：同版本不同内容被拒（每次改代码重打都会撞上，App Installer 有时
  # 还会把它显示成证书错误）。先卸载再装；注意这会清掉测试包的本地数据。
  if ($message -match "0x80073CFB") {
    Write-Host "[msix-test] 检测到同版本旧包，先卸载再装"
    $old = Get-AppxPackage -Name $identityName -ErrorAction SilentlyContinue
    if ($old) { Remove-AppxPackage -Package $old.PackageFullName }
    Add-AppxPackage -Path $Package
  } else {
    Write-Warning "安装失败：$message"
    Write-Warning "若提示旁加载被禁用：设置 → 隐私和安全性 → 开发者选项 → 打开「开发人员模式」。"
    throw
  }
}

$installed = Get-AppxPackage -Name $identityName | Select-Object -First 1
if (-not $installed) { throw "安装命令成功但找不到已注册的包：$identityName" }
Write-Host "[msix-test] 已安装: $($installed.PackageFullName)"
Write-Host "[msix-test] PFN: $($installed.PackageFamilyName)"

Start-Process "explorer.exe" -ArgumentList ("shell:appsFolder\" + $installed.PackageFamilyName + "!" + $appId)
Write-Host "[msix-test] 已请求启动（AUMID: $($installed.PackageFamilyName)!$appId）"
