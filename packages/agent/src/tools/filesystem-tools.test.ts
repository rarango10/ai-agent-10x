import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  executeEditFile,
  executeReadFile,
  executeWriteFileNewOnly,
  resolveWorkspacePath,
} from "./filesystem-tools";

function mkWorkspace(): { dir: string; config: Record<string, unknown> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-tools-"));
  const config = {
    terminals: { dev: { cwd: dir } },
    default_cwd: dir,
  };
  return { dir, config };
}

test("resolveWorkspacePath rejects absolute paths", () => {
  const { config } = mkWorkspace();
  const r = resolveWorkspacePath("dev", "/etc/passwd", config);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "ABSOLUTE_PATH_REJECTED");
});

test("resolveWorkspacePath rejects traversal outside workspace", () => {
  const { dir, config } = mkWorkspace();
  const outside = path.dirname(dir);
  const rel = path.relative(dir, path.join(outside, "escape.txt"));
  const r = resolveWorkspacePath("dev", rel, config);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "PATH_OUTSIDE_WORKSPACE");
});

test("read_file returns line slice and metadata", () => {
  const { dir, config } = mkWorkspace();
  fs.writeFileSync(path.join(dir, "a.txt"), "L1\nL2\nL3", "utf8");
  const r = executeReadFile({
    terminal: "dev",
    path: "a.txt",
    offset: 2,
    limit: 2,
    configJson: config,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.content, "L2\nL3");
    assert.equal(r.totalLines, 3);
    assert.equal(r.startLine, 2);
    assert.equal(r.linesReturned, 2);
  }
});

test("write_file creates file and rejects second write", () => {
  const { dir, config } = mkWorkspace();
  const w1 = executeWriteFileNewOnly({
    terminal: "dev",
    path: "new.txt",
    content: "hello",
    configJson: config,
  });
  assert.equal(w1.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "new.txt"), "utf8"), "hello");

  const w2 = executeWriteFileNewOnly({
    terminal: "dev",
    path: "new.txt",
    content: "again",
    configJson: config,
  });
  assert.equal(w2.ok, false);
  if (!w2.ok) assert.equal(w2.code, "FILE_ALREADY_EXISTS");
});

test("edit_file replaces single match", () => {
  const { dir, config } = mkWorkspace();
  fs.writeFileSync(path.join(dir, "e.txt"), "foo bar foo", "utf8");
  const bad = executeEditFile({
    terminal: "dev",
    path: "e.txt",
    old_string: "foo",
    new_string: "x",
    configJson: config,
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, "AMBIGUOUS_MATCH");

  fs.writeFileSync(path.join(dir, "e2.txt"), "foo bar baz", "utf8");
  const ok = executeEditFile({
    terminal: "dev",
    path: "e2.txt",
    old_string: "bar",
    new_string: "qux",
    configJson: config,
  });
  assert.equal(ok.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "e2.txt"), "utf8"), "foo qux baz");
});

test("edit_file NOT_FOUND when old_string missing", () => {
  const { dir, config } = mkWorkspace();
  fs.writeFileSync(path.join(dir, "x.txt"), "abc", "utf8");
  const r = executeEditFile({
    terminal: "dev",
    path: "x.txt",
    old_string: "nope",
    new_string: "y",
    configJson: config,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "NOT_FOUND");
});
