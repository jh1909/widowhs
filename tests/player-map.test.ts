import assert from "node:assert/strict";
import test from "node:test";
import { createPlayerMap } from "../supabase/functions/_shared/player-map.ts";

test("old names and linked accounts still import into the renamed profile", () => {
  const player = { name: "NewName", bnet_accounts: ["BattleName"], previous_names: ["OldName", "OlderName"] };
  const map = createPlayerMap([player]);
  for (const name of ["newname", "oldname", "oldername", "battlename"]) {
    assert.equal(map.get(name), player);
  }
});

test("missing alias columns remain compatible with an older database", () => {
  const player = { name: "NewName", bnet_accounts: null };
  assert.equal(createPlayerMap([player]).get("newname"), player);
  assert.equal(createPlayerMap([{ name: "NewName", previous_names: ["newNAME"] }]).size, 1);
});

test("ambiguous account aliases reject the upload instead of choosing a wrong profile", () => {
  assert.throws(() => createPlayerMap([
    { name: "NewName", previous_names: ["OldName"] },
    { name: "Other", bnet_accounts: ["oldname"] },
  ]), /linked to multiple profiles/);
});
