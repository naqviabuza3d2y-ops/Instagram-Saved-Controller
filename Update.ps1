# Windows PowerShell 5.1+. Run Update.cmd; dot-source only for automated tests.
$ErrorActionPreference = 'Stop'

function Assert-UpdateFile {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Expected an ordinary file: $Path"
        }
    }
}

function Set-UpdateFile {
    param([string]$Source, [string]$Destination)
    Assert-UpdateFile $Destination
    # Replace on the same volume; a failed replacement must not truncate the old file.
    $pending = $Destination + '.update-' + [guid]::NewGuid().ToString('N')
    try {
        [IO.File]::Copy($Source, $pending)
        if ([IO.File]::Exists($Destination)) {
            [IO.File]::Replace($pending, $Destination, [NullString]::Value)
        } else {
            [IO.File]::Move($pending, $Destination)
        }
    } finally {
        if ([IO.File]::Exists($pending)) { [IO.File]::Delete($pending) }
    }
}

function Get-UpdateArchive {
    param([string]$Uri, [string]$Destination)
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing -TimeoutSec 120
}

function Get-UpdateHash {
    param([string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)) }
    finally { $hash.Dispose(); $stream.Dispose() }
}

function Expand-UpdateFiles {
    param([string]$ArchivePath, [string]$StageDirectory, [string[]]$Files)
    if ((Get-Item -LiteralPath $ArchivePath).Length -gt 50MB) { throw 'The update ZIP is too large.' }
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $entries = @{}
        $root = 'Instagram-Saved-Controller-main/'
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if (!$name.StartsWith($root, [StringComparison]::Ordinal) -or
                $name.Contains(':') -or ($name.Split('/') | Where-Object { $_ -eq '..' -or $_ -eq '.' })) {
                throw 'The update ZIP contains an unexpected or unsafe path.'
            }
            if (($entry.ExternalAttributes -band 0x400) -or
                (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
                throw 'The update ZIP contains a link instead of an ordinary file.'
            }
            $relative = $name.Substring($root.Length)
            if ($Files -contains $relative) {
                if ($entries.ContainsKey($relative)) { throw "Duplicate update file: $relative" }
                $entries[$relative] = $entry
            }
        }
        foreach ($file in $Files) {
            if (!$entries.ContainsKey($file)) { throw "The update ZIP is missing $file." }
            $entry = $entries[$file]
            if ($entry.Length -eq 0 -or $entry.Length -gt 10MB) { throw "Invalid size for update file: $file" }
            # Extract only known, top-level files. Never extract ZIP-supplied paths.
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $StageDirectory $file))
        }
        $manifest = Get-Content -LiteralPath (Join-Path $StageDirectory 'manifest.json') -Raw | ConvertFrom-Json
        if ($manifest.name -ne 'Instagram Saved Review' -or $manifest.manifest_version -ne 3 -or
            $manifest.version -notmatch '^\d+(\.\d+){0,3}$') {
            throw 'The update ZIP does not contain a valid Instagram Saved Review manifest.'
        }
        return $manifest.version
    } finally {
        $zip.Dispose()
    }
}

function Invoke-ZipUpdate {
    param(
        [string]$InstallDirectory = $PSScriptRoot,
        [scriptblock]$DownloadArchive = { param($uri, $destination) Get-UpdateArchive $uri $destination }
    )
    $install = (Get-Item -LiteralPath $InstallDirectory -Force).FullName
    if (!(Test-Path -LiteralPath (Join-Path $install 'manifest.json') -PathType Leaf)) {
        throw 'Keep Update.cmd and Update.ps1 in the installed extension folder, beside manifest.json.'
    }
    if (Test-Path -LiteralPath (Join-Path $install '.git')) {
        throw 'This is a Git checkout. Use git pull instead of the ZIP updater.'
    }
    if ((Get-Item -LiteralPath $install -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Run the updater from an ordinary extension folder, not a directory link.'
    }
    Assert-UpdateFile (Join-Path $install 'manifest.json')
    $installed = Get-Content -LiteralPath (Join-Path $install 'manifest.json') -Raw | ConvertFrom-Json
    if ($installed.name -ne 'Instagram Saved Review' -or $installed.manifest_version -ne 3) {
        throw 'This folder is not an Instagram Saved Review installation.'
    }

    $files = @('background.js', 'content.js', 'export.mjs', 'popup.html', 'popup.mjs',
        'README.md', 'Update.ps1', 'Update.cmd', 'manifest.json')
    $lockPath = Join-Path $install '.update.lock'
    Assert-UpdateFile $lockPath
    $lock = $null
    $work = $null
    $backup = $null
    $changed = [Collections.Generic.List[string]]::new()
    try {
        try {
            $lock = [IO.FileStream]::new($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite,
                [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose)
        } catch { throw 'Cannot lock this installation. Another update may be running, or the folder is not writable.' }

        Write-Host 'Instagram Saved Review updater'
        Write-Host 'Pause review and finish any Undo before updating. Keep this extension installed in this folder.'
        Write-Host 'Downloading the latest merged code from GitHub main...'
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        $work = Join-Path $tempRoot ('instagram-saved-update-' + [guid]::NewGuid().ToString('N'))
        $null = [IO.Directory]::CreateDirectory($work)
        $stage = Join-Path $work 'stage'
        $null = [IO.Directory]::CreateDirectory($stage)
        $archive = Join-Path $work 'update.zip'
        & $DownloadArchive 'https://github.com/naqviabuza3d2y-ops/Instagram-Saved-Controller/archive/refs/heads/main.zip' $archive | Out-Null
        $version = Expand-UpdateFiles $archive $stage $files
        $incoming = Get-Content -LiteralPath (Join-Path $stage 'manifest.json') -Raw | ConvertFrom-Json
        if ($installed.key -cne $incoming.key) {
            throw 'The update changes the extension identity key. No files changed; saved progress requires the same extension identity.'
        }

        $updates = @($files | Where-Object {
            $target = Join-Path $install $_
            Assert-UpdateFile $target
            !(Test-Path -LiteralPath $target) -or
                (Get-UpdateHash $target) -ne (Get-UpdateHash (Join-Path $stage $_))
        })
        if ($updates.Count -eq 0) {
            Write-Host 'Already up to date. No files were changed.'
        } else {
            $backupRoot = Join-Path $install '.update-backups'
            if (Test-Path -LiteralPath $backupRoot) {
                $item = Get-Item -LiteralPath $backupRoot -Force
                if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                    throw 'The backup location must be an ordinary directory.'
                }
            }
            $backup = Join-Path $backupRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
            $backupFiles = Join-Path $backup 'files'
            $null = [IO.Directory]::CreateDirectory($backupFiles)
            $existed = @{}
            # Finish the entire backup before replacing anything, including the updater itself.
            foreach ($file in $updates) {
                $target = Join-Path $install $file
                $existed[$file] = [IO.File]::Exists($target)
                if ($existed[$file]) { [IO.File]::Copy($target, (Join-Path $backupFiles $file)) }
            }
            $existed | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backup 'original-files.json') -Encoding UTF8
            try {
                foreach ($file in $updates) {
                    Set-UpdateFile (Join-Path $stage $file) (Join-Path $install $file)
                    $changed.Add($file)
                }
            } catch {
                $failure = $_.Exception.Message
                $rollbackErrors = @()
                for ($i = $changed.Count - 1; $i -ge 0; $i--) {
                    $file = $changed[$i]
                    try {
                        if ($existed[$file]) {
                            Set-UpdateFile (Join-Path $backupFiles $file) (Join-Path $install $file)
                        } else { [IO.File]::Delete((Join-Path $install $file)) }
                    } catch { $rollbackErrors += $file }
                }
                if ($rollbackErrors.Count) {
                    throw "Update failed: $failure. Restore these files from ${backupFiles}: $($rollbackErrors -join ', '). Do not reload Chrome until restored."
                }
                throw "Update failed; previous files were restored. $failure. Backup: $backup"
            }
            Write-Host "Updated extension files (manifest version $version). Backup: $backup"
        }
        Write-Host 'Saved progress stays in Chrome; this helper never accesses browser profiles.'
        Write-Host 'Next: open chrome://extensions, click Reload for Instagram Saved Review, then refresh Instagram tabs.'
        Write-Host 'Use Start review to resume. Do not remove or re-add the extension, or move its folder.'
    } finally {
        if ($lock) { $lock.Dispose() }
        if ($work -and (Test-Path -LiteralPath $work)) {
            # Only recursively remove the unique directory created under the system temp root.
            $resolved = [IO.Path]::GetFullPath($work)
            $prefix = $tempRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
            if (!$resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
                [IO.Path]::GetFileName($resolved) -notmatch '^instagram-saved-update-[a-f0-9]{32}$') {
                throw 'Refusing to clean an unexpected temporary path.'
            }
            try { Remove-Item -LiteralPath $resolved -Recurse -Force } catch { Write-Warning "Temporary files remain at $resolved" }
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-ZipUpdate } catch {
        Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
        exit 1
    }
}
