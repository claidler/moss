const test = require("node:test");
const assert = require("node:assert/strict");
const { primaryMime, filenameFor, groqMultipart, MODEL } = require("./transcribe");

test("primaryMime strips codec params", () => {
  assert.equal(primaryMime("audio/webm;codecs=opus"), "audio/webm");
});

test("primaryMime rejects non-audio types", () => {
  assert.equal(primaryMime("application/json"), "");
  assert.equal(primaryMime(""), "");
});

test("filenameFor maps allowed audio types", () => {
  assert.equal(filenameFor("audio/ogg;codecs=opus"), "note.ogg");
  assert.equal(filenameFor("audio/webm"), "note.webm");
  assert.equal(filenameFor("nope"), "note.webm");
});

test("multipart includes whisper-large-v3-turbo and the file bytes", () => {
  const { body, boundary } = groqMultipart(Buffer.from("abc"), "audio/webm;codecs=opus");
  const s = body.toString("latin1");
  assert.equal(MODEL, "whisper-large-v3-turbo");
  assert.match(s, /whisper-large-v3-turbo/);
  assert.match(s, /name="language"/);
  assert.match(s, /\r\nen\r\n/);
  assert.match(s, /filename="note.webm"/);
  assert.match(s, /Content-Type: audio\/webm/);
  assert.ok(s.includes("abc"));
  assert.ok(s.includes("--" + boundary + "--"));
});
