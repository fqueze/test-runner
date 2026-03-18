#!/usr/bin/env node
// add-config.js — register a Mozilla build directory with test-runner
//
// Usage: node add-config.js <mozilla_src> [<mozilla_src2> ...]
//
// Finds all obj dirs under mozilla_src, reads mozinfo.json to determine
// build type (opt/debug) and architecture, then adds them to
// ~/.test-runner/config.json (creating the file if needed).

const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_PATH = path.join(os.homedir(), ".test-runner", "config.json");
const DEFAULT_PORT = 3000;

function findObjDirs(mozillaSrc) {
  let entries;
  try {
    entries = fs.readdirSync(mozillaSrc);
  } catch (err) {
    console.error(`Cannot read directory: ${mozillaSrc}`);
    process.exit(1);
  }

  const objDirs = [];
  for (const entry of entries) {
    if (!entry.startsWith("obj-")) continue;
    const moziInfoPath = path.join(mozillaSrc, entry, "mozinfo.json");
    if (fs.existsSync(moziInfoPath)) {
      objDirs.push({ obj_dir: entry, mozinfoPath: moziInfoPath });
    }
  }
  return objDirs;
}

function buildConfigName(mozinfo, existingNames) {
  const osMap = {
    mac: "macos",
    linux: "linux",
    win: "win",
  };
  const archMap = {
    x86_64: "x64",
    aarch64: "arm64",
    x86: "x86",
  };

  const osName = osMap[mozinfo.os] || mozinfo.os;
  const arch = archMap[mozinfo.processor] || mozinfo.processor;
  const buildType = mozinfo.debug ? "debug" : "opt";
  const artifact = mozinfo.artifact ? "-artifact" : "";

  // Only include arch suffix if it's not the obvious default for the OS
  // (aarch64 on mac, x86_64 on linux/win are common enough to omit)
  const omitArch =
    (mozinfo.os === "mac" && mozinfo.processor === "aarch64") ||
    (mozinfo.os === "linux" && mozinfo.processor === "x86_64") ||
    (mozinfo.os === "win" && mozinfo.processor === "x86_64");

  const baseName = omitArch
    ? `${osName}${artifact}-${buildType}`
    : `${osName}-${arch}${artifact}-${buildType}`;

  // Avoid duplicate names by appending a number
  let name = baseName;
  let i = 2;
  while (existingNames.has(name)) {
    name = `${baseName}-${i++}`;
  }
  return name;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { port: DEFAULT_PORT, configs: [] };
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

function saveConfig(config) {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: node add-config.js <mozilla_src> [<mozilla_src2> ...]");
    process.exit(1);
  }

  const config = loadConfig();
  const existingNames = new Set(config.configs.map((c) => c.name));
  let added = 0;

  for (const rawSrc of args) {
    const mozillaSrc = path.resolve(rawSrc);

    if (!fs.existsSync(mozillaSrc)) {
      console.error(`Directory not found: ${mozillaSrc}`);
      continue;
    }

    const objDirs = findObjDirs(mozillaSrc);
    if (objDirs.length === 0) {
      console.error(`No obj-* directories with mozinfo.json found in: ${mozillaSrc}`);
      console.error("Make sure you have run './mach build' at least once.");
      continue;
    }

    for (const { obj_dir, mozinfoPath } of objDirs) {
      let mozinfo;
      try {
        mozinfo = JSON.parse(fs.readFileSync(mozinfoPath, "utf-8"));
      } catch (err) {
        console.error(`Failed to parse ${mozinfoPath}: ${err.message}`);
        continue;
      }

      // Check for duplicate by mozilla_src + obj_dir
      const duplicate = config.configs.find(
        (c) => c.mozilla_src === mozillaSrc && c.obj_dir === obj_dir
      );
      if (duplicate) {
        console.log(`Already registered: ${duplicate.name} (${mozillaSrc} / ${obj_dir})`);
        continue;
      }

      const name = buildConfigName(mozinfo, existingNames);
      existingNames.add(name);

      config.configs.push({ name, mozilla_src: mozillaSrc, obj_dir });

      const buildType = mozinfo.debug ? "debug" : "opt";
      console.log(`Added: ${name}`);
      console.log(`  src: ${mozillaSrc}`);
      console.log(`  obj: ${obj_dir}`);
      console.log(`  os:  ${mozinfo.os}, arch: ${mozinfo.processor}, build: ${buildType}`);
      added++;
    }
  }

  if (added > 0) {
    saveConfig(config);
    console.log(`\nSaved to ${CONFIG_PATH}`);
  } else {
    console.log("Nothing to add.");
  }
}

main();
