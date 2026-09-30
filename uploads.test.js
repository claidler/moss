// Pin the Lean counterexamples (proofs/Uploads.lean) against the real
// isManagedUploadPath, so the JS and the proof share one witness.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { isManagedUploadPath, UPLOAD_DIR } = require("./uploads");

function touch(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "x");
  return p;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "moss-uploads-test-"));
const real = touch(path.join(UPLOAD_DIR, "proof-pinned.txt"));

test("accepts a real file inside the managed dir", () => {
  assert.strictEqual(isManagedUploadPath(real), true);
});

test("rejects the Lean counterexample: traversal out of the managed dir", () => {
  // proofs/Uploads.lean :: sneaky = managed/../.ssh/id_rsa
  const sneaky = path.join(UPLOAD_DIR, "..", ".ssh", "id_rsa");
  assert.strictEqual(isManagedUploadPath(sneaky), false);
  // ...and it is rejected even when the target file exists:
  const escapee = touch(path.join(tmp, ".ssh", "id_rsa"));
  assert.strictEqual(isManagedUploadPath(escapee), false);
});

test("rejects a sibling dir whose name extends the managed prefix", () => {
  // The string-level bug a raw startsWith(UPLOAD_DIR) would allow;
  // invisible in the segment model, so it is pinned here instead.
  const sibling = touch(UPLOAD_DIR + "-evil/pwned.txt");
  assert.strictEqual(isManagedUploadPath(sibling), false);
});

test("rejects missing files, relative paths, and empty input", () => {
  assert.strictEqual(isManagedUploadPath(path.join(UPLOAD_DIR, "nope.bin")), false);
  assert.strictEqual(isManagedUploadPath("moss-uploads/proof-pinned.txt"), false);
  assert.strictEqual(isManagedUploadPath(""), false);
  assert.strictEqual(isManagedUploadPath(null), false);
});

test.after(() => {
  fs.rmSync(real, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});
