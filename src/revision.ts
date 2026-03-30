import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export function getBranch(mozillaSrc: string): string {
  if (fs.existsSync(path.join(mozillaSrc, ".git"))) {
    try {
      return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: mozillaSrc,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
    } catch {
      return "unknown";
    }
  }

  if (fs.existsSync(path.join(mozillaSrc, ".hg"))) {
    try {
      return execFileSync("hg", ["branch"], {
        cwd: mozillaSrc,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
    } catch {
      return "unknown";
    }
  }

  return "unknown";
}

export function getRevision(mozillaSrc: string): string {
  if (fs.existsSync(path.join(mozillaSrc, ".git"))) {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: mozillaSrc,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  }

  if (fs.existsSync(path.join(mozillaSrc, ".hg"))) {
    return execFileSync("hg", ["parent", "--template", "{node}"], {
      cwd: mozillaSrc,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  }

  return "unknown";
}
