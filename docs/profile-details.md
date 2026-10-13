# Bio und Setup

Die optionalen Angaben erscheinen auf dem Spielerprofil zwischen der Playerbox
und den Statistiken. Leere Felder werden für Besucher ausgeblendet. Der
angemeldete Profilinhaber und Administratoren können sie direkt auf dem
Spielerprofil bearbeiten. Im Bearbeitungsformular können Admins mit
„Clear bio & setup“ und anschließender Bestätigung alle Angaben entfernen.
Einzelne Angaben lassen sich durch Leeren des betreffenden Feldes entfernen.

Felder: Bio (500 Zeichen), Maus, Mauspad, Tastatur, Monitor, DPI, In-game- und
Scoped-Sensitivity (je 120 Zeichen), Crosshair (500) und weitere Settings (1000).
Die Anzeige erfolgt als Text, ohne HTML-Auswertung oder externe Einbettungen.

`supabase/migrations/20261013200000_profile_bio_and_setup.sql` vollständig nach
den bisherigen Migrationen ausführen. Es ist kein Edge-Function-Update nötig.
Erst danach das Frontend veröffentlichen.

Für die Admin-Moderation zusätzlich
`20261013220000_admin_profile_details_moderation.sql` installieren. Der RPC
prüft den Admin-Status aus `players.is_admin` des angemeldeten Benutzers.
Normale Benutzer bleiben auf das eigene Profil beschränkt. Fremde Änderungen
werden als `MODERATE_PROFILE_DETAILS` in `audit_logs` protokolliert, ohne die
entfernten Inhalte zu speichern. Schlägt das Audit fehl, wird die Änderung
zurückgerollt. Die Moderation ändert keine Stats, Kontoverknüpfungen oder Rollen.

Die Moderationsmigration wurde am 13. Oktober 2026 im Live-Projekt bereits
installiert. Die bestehenden sechs Profildatensätze blieben bei der
Installation erhalten; es wurde keine Bio bearbeitet oder gelöscht.
Der read-only Einrichtungsnachweis ist gespeichert unter
https://supabase.com/dashboard/project/kzymescftenxuspjsssh/sql/f3b56a31-6616-44bb-8e89-ec52a9be1815.
Kein Edge-Function-Update nötig; das neue Formular wird nach dem Frontend-Push
verfügbar.

Im Projekt `widowhs` (`kzymescftenxuspjsssh`) wurde diese Migration am
13. Oktober 2026 bereits installiert. Die öffentliche API wurde mit dem
Frontend-Publishable-Key geprüft: Profilabruf HTTP 200, direkter Zugriff auf
die private Tabelle HTTP 401. Der gespeicherte SQL-Nachweis befindet sich unter
https://supabase.com/dashboard/project/kzymescftenxuspjsssh/sql/70096cb1-38cb-45bd-bbbd-ab3a188bb20e.

Die private Tabelle `player_profile_details` ist an `auth.users.id` gebunden.
Öffentlich abrufbar sind ausschließlich Bio und Setup eines vorhandenen
Spielerprofils über `get_player_profile_details`. Tabellenzugriffe für `anon`
und `authenticated` sind gesperrt; `update_player_profile_details` prüft die
Profilinhaberschaft und validiert die Eingaben in der Datenbank.

Umbenennungen, Account-Verknüpfungen, Zusammenführungen eigener Profile und
Leaderboard-Resets behalten die Angaben. Fremde Namensansprüche übertragen
keine persönliche Bio oder Ausstattung. Wird das letzte Spielerprofil eines
Nutzers oder sein Auth-Konto gelöscht, werden auch dessen Angaben entfernt.
Bei Löschanfragen sind diese Angaben ebenfalls personenbezogene Profildaten.
