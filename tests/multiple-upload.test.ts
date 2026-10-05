import assert from "node:assert/strict";
import test from "node:test";
import { readMatchSources, validateMatchFile } from "../supabase/functions/_shared/match-upload.ts";

function requestWithFiles(files: File[]) {
  const form = new FormData();
  files.forEach((file) => form.append("file", file));
  return new Request("https://example.test/upload", { method: "POST", body: form });
}

test("keeps every file in a mixed CSV/TXT upload, including Unicode text", async () => {
  const csv = "Player,kills,deaths,accuracy,kpm,kdr,crouches,time\nNZT,50,18,43.9,11.04,2.78,41,271";
  const txt = "[00:04:38] Лев,5,15,10.20,1.77,0.33,9,169,271";
  const sources = await readMatchSources(requestWithFiles([
    new File([csv], "match1.csv"), new File([txt], "match2.TXT"),
  ]));
  assert.deepEqual(sources, [{ name: "match1.csv", text: csv }, { name: "match2.TXT", text: txt }]);
});

test("single-file automation and raw-text uploads remain compatible", async () => {
  const text = "NZT,50,18,43.9,11.04,2.78,41,271,271";
  assert.deepEqual(await readMatchSources(requestWithFiles([new File([text], "match.csv")])),
    [{ name: "match.csv", text }]);
  assert.deepEqual(await readMatchSources(new Request("https://example.test/upload", { method: "POST", body: text })),
    [{ name: "Request body", text }]);
});

test("rejects a batch containing an unsupported file instead of silently skipping it", async () => {
  await assert.rejects(() => readMatchSources(requestWithFiles([
    new File(["valid"], "match.csv"), new File(["invalid"], "match.pdf"),
  ])), /match.pdf: please select a CSV or TXT file/);
});

test("rejects missing files and text fields pretending to be files", async () => {
  await assert.rejects(() => readMatchSources(requestWithFiles([])), /No files uploaded/);
  const form = new FormData();
  form.append("file", "not a file");
  await assert.rejects(() => readMatchSources(new Request("https://example.test/upload", { method: "POST", body: form })),
    /invalid file format/);
});

test("enforces the size limit per file", () => {
  assert.doesNotThrow(() => validateMatchFile({ name: "match.csv", size: 5 * 1024 * 1024 }));
  assert.throws(() => validateMatchFile({ name: "large.txt", size: 5 * 1024 * 1024 + 1 }),
    /large.txt: maximum file size is 5MB/);
});
