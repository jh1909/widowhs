# Battle.net OAuth

Branch: `main`. Discord bleibt der Website-Login. Battle.net
wird zusätzlich mit dem bestehenden Discord-Profil verknüpft. Maximal zwei
Konten. Ein OAuth-bestätigtes Konto hat Vorrang vor unbestätigten Namensansprüchen
(Groß-/Kleinschreibung egal). Zwischen bereits OAuth-bestätigten Konten gewinnt
der erste Anspruch auf einen Namen. Unbeanspruchte importierte Profile werden
wie bisher mit allen Matchdaten zusammengeführt. Ein belegter Anzeigename wird
bei der Discord-Registrierung zunächst mit einem eindeutigen Zusatz versehen;
nach Battle.net-Verifizierung kann der freigegebene Name verwendet werden.

Alte manuelle Ansprüche unter einer fremden Discord-ID werden freigegeben.
Das fremde Discord-Profil, seine übrigen Konten und seine Admin-Rechte bleiben
erhalten. Es wechseln nur Match-Zeilen mit dem passenden
ursprünglichen Log-Namen zum verifizierten Eigentümer; Statistiken werden entsprechend
umgebucht. Gemischte historische ELO-Snapshots und nicht eindeutig zuordenbare
Alt-Daten verbleiben beim ursprünglichen Profil. Die Prüfung gilt pro Kontoname;
ein verifiziertes Zweitkonto schützt keine unbestätigten Namen. Namenswechsel bzw.
Wiedervergabe bei Blizzard erhalten vorerst keine zusätzliche Sonderbehandlung.
Neue Logs dieses freigegebenen Namens gehören dem neuen verifizierten Konto.

Verified bedeutet auf diesem Branch eine tatsächliche Battle.net-Anmeldung.
Alte manuelle Verknüpfungen behalten ihre Namen und Statistiken, verlieren aber
das Badge bis zur Bestätigung durch Blizzard. Bestehende Namen können auch dann
bestätigt werden, wenn bereits zwei Konten eingetragen sind.

## Testumgebung

Ein Git-Branch trennt den Frontend-Code, **nicht** die Supabase-Datenbank. Für
einen unabhängigen Test ein separates Supabase-Testprojekt bzw. eine Supabase-
Datenbankbranch mit dem bestehenden Schema und den bisherigen Migrationen nutzen.
Keine produktiven Auth-Konten oder Geheimnisse in Testdateien kopieren.
Ohne gesonderte Datenbank wirkt die neue Migration auch auf die aktuelle Website:
manuelle neue Verknüpfungen werden abgelehnt und Verified benötigt OAuth.

In `.env.local` die URL und den öffentlichen Anon-/Publishable-Key des Testprojekts
als `VITE_SUPABASE_URL` und `VITE_SUPABASE_ANON_KEY` eintragen. Diese Datei ist
ignoriert. Discord-Login im Testprojekt konfigurieren und die lokale Website-
Adresse dort als erlaubte Supabase-Auth-Redirect-URL hinterlegen.
In dieser Sitzung wurde auf ausdrücklichen Wunsch das bestehende Projekt
`kzymescftenxuspjsssh` eingerichtet. Die lokale Version nutzt dessen Datenbank;
sie ist damit nicht von den Live-Spielerdaten getrennt. Das GitHub-Pages-Frontend
wurde für den OAuth-Test nicht veröffentlicht.

## Blizzard-Client anlegen

Im [Battle.net Developer Portal](https://develop.battle.net/) einen OAuth-Client
für WIDOW HS erstellen. Blizzard beschreibt dies auch in seinem
[offiziellen Beispiel](https://github.com/Blizzard/oauth-client-sample).
Diese Redirect URI registrieren, mit dem Ref **deines Testprojekts**:

```text
https://<TEST-PROJECT-REF>.supabase.co/functions/v1/battlenet-oauth/callback
```

Die Redirect URI ist die Edge Function, nicht GitHub Pages und nicht der
Supabase-Discord-Callback. Client ID und Client Secret erhältst du im Portal.
Das Secret nur in Supabase hinterlegen, niemals im Frontend, Git oder Chat.

## Supabase per Dashboard einrichten

1. Im **Testprojekt** im SQL Editor
   `supabase/migrations/20261012220000_battlenet_oauth.sql` vollständig ausführen.
   Voraussetzung ist insbesondere `20261012140000_global_match_history.sql`.
   Anschließend `20261013010000_battlenet_owned_profile_claims.sql` ausführen.
   Diese Korrektur verhindert, dass ein eigenes älteres Profil denselben
   Discord-Nutzer beim Verknüpfen blockiert, und bewahrt dessen Konten/Matchdaten.
   Danach `20261013140000_verified_battlenet_claim_priority.sql` ausführen, um
   OAuth-bestätigten Namen Vorrang vor importierten/manuellen Ansprüchen zu geben.
   Die Installation selbst überträgt keine Profile oder Matches; das passiert
   erst bei einer erfolgreichen OAuth-Verknüpfung.
   Danach `20261013180000_pb_rankings_and_records.sql` für PB-Sortierung und
   Record Holder installieren; Details stehen in `docs/pb-rankings.md`.
   Vorherige Migrationen nicht nach der neuesten OAuth-Korrektur erneut installieren,
   da sie sonst die alten Account-Link-/Verified-Funktionen wiederherstellen.
2. Unter **Edge Functions → Secrets** diese Werte speichern:

   | Name | Wert |
   | --- | --- |
   | `BATTLENET_CLIENT_ID` | Client ID von Blizzard |
   | `BATTLENET_CLIENT_SECRET` | Client Secret von Blizzard |
   | `BATTLENET_CALLBACK_URL` | Registrierte Callback-URL von oben |
   | `BATTLENET_REDIRECT_URLS` | `https://widowhs.com/,https://jh1909.github.io/widowhs/,http://127.0.0.1:4173/,http://localhost:4173/` |

   Rückkehr-Adressen müssen exakt passen, inklusive Unterverzeichnis und
   abschließendem Slash. Kein `#/profile/me`, Querystring oder Wildcard.
   Für eine zusätzliche gehostete Testseite deren vollständige Basisadresse
   ergänzen, z. B. `https://example.test/widowhs/`.
3. Standalone-Code für den Dashboard-Editor erzeugen:

   ```powershell
   node scripts/build-battlenet-dashboard.mjs
   ```

   Im Ausgabeordner des Workspace entsteht `battlenet-oauth-dashboard.ts`
   sowie eine Kopie der SQL-Migration.
4. Eine neue Edge Function **`battlenet-oauth`** anlegen und den kompletten Inhalt
   der Dashboard-Datei als `index.ts` einsetzen. Die Plattformoption
   **Verify JWT** für diese Funktion deaktivieren: Blizzards Browser-Callback
   hat kein Supabase-JWT. POST-Aufrufe werden innerhalb der Funktion mit
   `auth.getUser` geprüft, und der Callback benötigt einen einmaligen OAuth-State.
   Dies ist in `supabase/config.toml` für CLI-Deployments ebenfalls eingetragen.
   Die vorhandene `upload-csv`-Funktion muss dafür nicht geändert werden.

Alternativ mit installierter CLI:

```powershell
supabase functions deploy battlenet-oauth --project-ref <TEST-PROJECT-REF>
```

## Lokal öffnen und prüfen

```powershell
$env:NODE_OPTIONS='--preserve-symlinks --preserve-symlinks-main'
npm run build
npm run preview -- --host 127.0.0.1 --port 4173
```

Öffne `http://127.0.0.1:4173/`, melde dich mit Discord an und gehe auf dein
Profil. **Connect Battle.net** führt zu Blizzard und zurück in denselben Tab.
Die Rückkehr wird zusätzlich mit einem tabgebundenen Prüfwert und der ursprünglichen
Discord-Sitzung bestätigt. Ein fremder Nutzer, an den nur die Login-URL weitergegeben
wurde, kann damit kein Battle.net-Konto auf dem initiierenden Profil hinterlegen.

- Erstes Konto: voller BattleTag, Verified, bestehende passende Matches übernommen.
- Bereits OAuth-bestätigter Name (auch anderer `#Nummer`): Ablehnung ohne Datenänderung.
- Unverifizierter manueller Anspruch unter einer anderen Discord-ID: Freigabe,
  zuordenbare Matchdaten werden übertragen. Fremdes Profil, übrige Konten und
  Admin-Rechte bleiben bei dessen Discord-Nutzer. Die Prüfung erfolgt je Kontoname,
  auch wenn dessen Profil ein anderes verifiziertes Konto hat.
- Ein eigenes früheres Profil unter derselben Discord-ID blockiert den OAuth-Login
  nicht. Passende eigene Profile werden inklusive Statistiken, anderer Konten,
  Aliase und bestehender Admin-Rechte zusammengeführt. Fremde Ansprüche bleiben geschützt.
- Zweites Konto: zuvor in Battle.net zum anderen Konto wechseln; zusammengeführte
  Stats. Ein drittes Konto wird abgelehnt.
  Bei einer aktiven Blizzard-Sitzung kann OAuth unmittelbar zurückkehren, ohne
  erneut ein Loginformular anzuzeigen. Für einen Kontowechsel im Browser zunächst
  bei Battle.net abmelden; das Abmelden auf WIDOW HS ist dafür nicht erforderlich.
- Bestehendes manuelles Konto: OAuth bestätigt es ohne einen zusätzlichen Slot.
- Wiederholter Login desselben Kontos: keine doppelten Matches oder Konten.
- Abbrechen/abgelaufener Login/fremder Browser: keine neue Kontoverknüpfung.
- Letztes verifiziertes Konto entfernen: Badge verschwindet, Matchdaten bleiben.
- Blizzard-Namensänderung: erneut verbinden; Account-ID bleibt, neue Logs werden
  dem Profil zugeordnet und bisheriger Verlauf bleibt erhalten.

Workshop-Logs liefern nur Namen. Das Badge bestätigt die Kontrolle über ein
Battle.net-Konto; die Zuordnung einer Log-Zeile bleibt die vereinbarte Namensregel.
Bereits in der Vergangenheit vermischte gleichnamige Spieler werden nicht getrennt.

## Technische Prüfungen

```powershell
npm run lint
npm test
npm run build
```

Die Tests prüfen Authorization-Code-Austausch und Userinfo mit gemocktem Blizzard,
einmalige States, Browser-/Discord-Bindung, erlaubte Rückkehr-Adressen, private IDs,
Namenskollisionen, Migrationen für `text[]` und `jsonb`, History-Merge und Unlink.
Ein echter Blizzard-Login wurde in dieser Sitzung mit dem vom Nutzer eingerichteten
OAuth-Client erfolgreich getestet. Die neue Vorrangregel wird separat mit
PostgreSQL-Migrationstests geprüft.

Interne Account-IDs, OAuth-State-Hashes und vorbereitete Provider-Antworten liegen
in durch RLS gesperrten Tabellen. Öffentliche RPCs liefern nur Accountnamen,
BattleTags und Verified-Status. Provider-Zugriffs- und Refresh-Tokens werden nicht
gespeichert. Vorgänge verfallen nach zehn Minuten je Phase; weitere Starts löschen
abgelaufene Vorgänge. Fehler geben nur feste, unsensible Statuscodes weiter.

Referenzen: [Supabase-Funktionsauthentifizierung](https://supabase.com/docs/guides/functions/auth),
[Supabase-Secrets](https://supabase.com/docs/guides/functions/secrets),
[Battle.net OAuth-Endpunkte](https://oauth.battle.net/.well-known/openid-configuration).
