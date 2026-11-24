import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const windows = process.platform === "win32";
const updater = fileURLToPath(new URL("../Update.ps1", import.meta.url));
const launcher = fileURLToPath(new URL("../Update.cmd", import.meta.url));
const files = ["background.js", "content.js", "export.mjs", "popup.html", "popup.mjs",
  "README.md", "Update.ps1", "Update.cmd", "manifest.json"];
const ps = value => "'" + value.replaceAll("'", "''") + "'";
const manifest = version => JSON.stringify({ name: "Instagram Saved Review", manifest_version: 3, version });

function powershell(code, env = {}) {
  return new Promise((accept, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive",
      "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")],
    { env: { ...process.env, ...env }, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => accept({ code, stdout, stderr }));
  });
}

function runLauncher(path) {
  return new Promise((accept, reject) => {
    const child = spawn(process.env.ComSpec, ["/d", "/s", "/c", `""${path}" < NUL"`],
      { windowsHide: true, windowsVerbatimArguments: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => accept({ code, stdout, stderr }));
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "instagram-updater-test-"));
  t.after(async () => {
    const resolved = resolve(root);
    assert.ok(resolved.startsWith(resolve(tmpdir()) + sep));
    assert.match(resolved.slice(resolved.lastIndexOf(sep) + 1), /^instagram-updater-test-/);
    await rm(resolved, { recursive: true, force: true });
  });
  const install = join(root, "ZIP user's extension [test] (folder) !");
  await mkdir(install);
  for (const file of files) {
    await writeFile(join(install, file), file === "manifest.json" ? manifest("0.2.7") : "old " + file);
  }
  await writeFile(join(install, "Update.cmd"), await readFile(launcher));
  await writeFile(join(install, "Update.ps1"), await readFile(updater));
  const originals = Object.fromEntries(await Promise.all(files.map(async file =>
    [file, await readFile(join(install, file), "utf8")])));
  await writeFile(join(install, "saved_posts.json"), "user export - keep me");
  await writeFile(join(install, "notes.txt"), "user notes - keep me");
  const profile = join(root, "Browser profile");
  await mkdir(profile);
  const progress = JSON.stringify({ data: { schema: 1, ids: ["a", "b"],
    decisions: { a: "kept" }, deferred: ["b"], undoHistory: [] }, reviewBarPosition: { x: 0.2, y: 0.4 } });
  await writeFile(join(profile, "progress.json"), progress);
  const archive = join(root, "release.zip");
  async function zip(overrides = {}, extra = []) {
    const entries = files.filter(file => overrides[file] !== null).map(file => ({
      path: "Instagram-Saved-Controller-main/" + file,
      text: overrides[file] ?? (file === "manifest.json" ? manifest("0.2.8") : "new " + file)
    })).concat(extra);
    const input = join(root, "entries.json");
    await writeFile(input, JSON.stringify(entries));
    const result = await powershell(`$ErrorActionPreference = 'Stop'
      Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
      $zip = [IO.Compression.ZipFile]::Open(${ps(archive)}, [IO.Compression.ZipArchiveMode]::Create)
      try {
        foreach ($entry in (Get-Content -LiteralPath ${ps(input)} -Raw | ConvertFrom-Json)) {
          $item = $zip.CreateEntry($entry.path)
          $writer = [IO.StreamWriter]::new($item.Open())
          try { $writer.Write($entry.text) } finally { $writer.Dispose() }
        }
      } finally { $zip.Dispose() }`);
    assert.equal(result.code, 0, result.stderr);
  }
  async function run({ before = "", after = "", download = "", failure = false } = {}) {
    return powershell(`$ErrorActionPreference = 'Stop'
      . ${ps(updater)}
      ${before}
      try {
        Invoke-ZipUpdate -InstallDirectory ${ps(install)} -DownloadArchive {
          param($uri, $destination)
          if ($uri -ne 'https://github.com/naqviabuza3d2y-ops/Instagram-Saved-Controller/archive/refs/heads/main.zip') { throw 'Wrong update URL' }
          ${download || `[IO.File]::Copy(${ps(archive)}, $destination)`}
        }
        ${failure ? "throw 'Expected updater failure'" : ""}
      } catch {
        ${failure ? "Write-Output ('EXPECTED: ' + $_.Exception.Message)" : "throw"}
      } finally { ${after} }`);
  }
  async function assertPreserved() {
    assert.equal(await readFile(join(install, "saved_posts.json"), "utf8"), "user export - keep me");
    assert.equal(await readFile(join(install, "notes.txt"), "utf8"), "user notes - keep me");
    assert.equal(await readFile(join(profile, "progress.json"), "utf8"), progress);
    assert.ok(!(await readdir(install)).some(file => /\.update-[a-f0-9]{32}$|^\.update\.lock$/.test(file)));
  }
  async function assertOriginal() {
    for (const file of files) {
      if (Object.hasOwn(originals, file)) assert.equal(await readFile(join(install, file), "utf8"), originals[file], file);
      else await assert.rejects(readFile(join(install, file)), { code: "ENOENT" });
    }
    await assertPreserved();
  }
  return { root, install, archive, originals, zip, run, assertPreserved, assertOriginal };
}

test("ZIP updater installs in place, backs up replaced files, preserves progress, and handles unchanged versions", { skip: !windows }, async t => {
  const f = await fixture(t);
  await f.zip({ "manifest.json": manifest("0.2.7") });
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Updated extension files/);
  assert.match(result.stdout, /chrome:\/\/extensions/);
  assert.equal(await readFile(join(f.install, "content.js"), "utf8"), "new content.js");
  await f.assertPreserved();
  const backups = await readdir(join(f.install, ".update-backups"));
  assert.equal(backups.length, 1);
  for (const file of files.filter(file => file !== "manifest.json")) {
    assert.equal(await readFile(join(f.install, ".update-backups", backups[0], "files", file), "utf8"), f.originals[file]);
  }
  const again = await f.run();
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /Already up to date/);
  assert.deepEqual(await readdir(join(f.install, ".update-backups")), backups);
});

for (const [name, overrides, extra, message] of [
  ["incomplete ZIP", { "content.js": null }, [], /missing content.js/],
  ["wrong extension", { "manifest.json": '{"name":"Other","manifest_version":3,"version":"1"}' }, [], /valid Instagram Saved Review manifest/],
  ["changed extension identity", { "manifest.json": JSON.stringify({ name: "Instagram Saved Review", manifest_version: 3, version: "1", key: "different-identity" }) }, [], /extension identity key/],
  ["corrupt manifest", { "manifest.json": "{broken" }, [], /EXPECTED:/],
  ["empty runtime file", { "content.js": "" }, [], /Invalid size/],
  ["duplicate file", {}, [{ path: "Instagram-Saved-Controller-main/content.js", text: "duplicate" }], /Duplicate update file/],
  ["path traversal", {}, [{ path: "Instagram-Saved-Controller-main/../escape.txt", text: "escape" }], /unsafe path/],
  ["unexpected archive root", {}, [{ path: "Other-project/escape.txt", text: "escape" }], /unsafe path/]
]) {
  test("ZIP updater rejects " + name + " before changing installed files", { skip: !windows }, async t => {
    const f = await fixture(t);
    await f.zip(overrides, extra);
    const result = await f.run({ failure: true });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, message);
    assert.doesNotMatch(result.stdout, /Expected updater failure/);
    await f.assertOriginal();
    assert.ok(!(await readdir(f.install)).includes(".update-backups"));
  });
}

test("ZIP updater keeps all files intact when downloading fails", { skip: !windows }, async t => {
  const f = await fixture(t);
  const result = await f.run({ download: "throw 'Network unavailable'", failure: true });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Network unavailable/);
  await f.assertOriginal();
});

test("ZIP updater refuses Git checkouts and simultaneous updates", { skip: !windows }, async t => {
  const f = await fixture(t);
  await mkdir(join(f.install, ".git"));
  let result = await f.run({ failure: true });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Git checkout/);
  await rmdir(join(f.install, ".git"));
  result = await f.run({ failure: true,
    before: `$held = [IO.File]::Open(${ps(join(f.install, ".update.lock"))}, 'OpenOrCreate', 'ReadWrite', 'None')`,
    after: `$held.Dispose(); [IO.File]::Delete(${ps(join(f.install, ".update.lock"))})` });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Cannot lock this installation/);
  await f.assertOriginal();
});

test("ZIP updater rolls back earlier replacements when a later file is locked", { skip: !windows }, async t => {
  const f = await fixture(t);
  await f.zip();
  const result = await f.run({ failure: true,
    before: `$held = [IO.File]::Open(${ps(join(f.install, "content.js"))}, 'Open', 'Read', 'Read')`,
    after: "$held.Dispose()" });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /previous files were restored/);
  await f.assertOriginal();
});

test("Rollback removes newly added files and restores the updater itself", { skip: !windows }, async t => {
  const f = await fixture(t);
  await rm(join(f.install, "README.md"));
  delete f.originals["README.md"];
  await f.zip();
  const result = await f.run({ failure: true,
    before: `$held = [IO.File]::Open(${ps(join(f.install, "manifest.json"))}, 'Open', 'Read', 'Read')`,
    after: "$held.Dispose()" });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /previous files were restored/);
  await f.assertOriginal();
});

test("Production download function handles HTTP downloads and failures", { skip: !windows }, async t => {
  const f = await fixture(t);
  const payload = Buffer.from("test ZIP download");
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/ok" ? 200 : 503, { "Content-Type": "application/zip" });
    response.end(payload);
  });
  await new Promise(accept => server.listen(0, "127.0.0.1", accept));
  t.after(() => new Promise(accept => server.close(accept)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const result = await powershell(`$ErrorActionPreference = 'Stop'
    . ${ps(updater)}
    Get-UpdateArchive ${ps(url + "/ok")} ${ps(f.archive)}
    try { Get-UpdateArchive ${ps(url + "/fail")} ${ps(f.archive + ".bad")}; throw 'Expected HTTP failure' }
    catch { if ($_.Exception.Message -eq 'Expected HTTP failure') { throw }; Write-Output 'HTTP error handled' }`);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /HTTP error handled/);
  assert.deepEqual(await readFile(f.archive), payload);
});

test("Double-click launcher reports errors without replacing code in Git checkouts", { skip: !windows }, async t => {
  const f = await fixture(t);
  await mkdir(join(f.install, ".git"));
  const result = await runLauncher(join(f.install, "Update.cmd"));
  assert.equal(result.code, 1, JSON.stringify(result));
  assert.match(result.stdout, /Git checkout/, JSON.stringify(result));
  assert.match(result.stdout, /Update failed/);
  await f.assertOriginal();
});

test("Double-click launcher finishes successfully even when the update replaces both helpers", { skip: !windows }, async t => {
  const f = await fixture(t);
  await f.zip({ "Update.cmd": "@echo off\r\necho UNEXPECTED-NEW-LAUNCHER\r\nexit /b 7\r\n" });
  // Bootstrap a local archive in this fixture only; production still downloads the fixed GitHub URL.
  await writeFile(join(f.install, "Update.ps1"), `$ErrorActionPreference = 'Stop'
    . ${ps(updater)}
    try {
      Invoke-ZipUpdate -InstallDirectory $PSScriptRoot -DownloadArchive {
        param($uri, $destination) [IO.File]::Copy(${ps(f.archive)}, $destination)
      }
    } catch { Write-Host $_.Exception.Message; exit 1 }
  `);
  const result = await runLauncher(join(f.install, "Update.cmd"));
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.match(result.stdout, /Updated extension files/);
  assert.doesNotMatch(result.stdout, /UNEXPECTED-NEW-LAUNCHER|Update failed/);
  assert.equal(await readFile(join(f.install, "Update.ps1"), "utf8"), "new Update.ps1");
  await f.assertPreserved();
});
