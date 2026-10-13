# Bio und Setup

Die optionalen Angaben erscheinen auf dem Spielerprofil zwischen der Playerbox
und den Statistiken. Leere Felder werden für Besucher ausgeblendet. Nur der
angemeldete Profilinhaber kann sie bearbeiten, auch Administratoren können die
Angaben anderer Nutzer nicht über den Bearbeitungs-RPC ändern.

Felder: Bio (500 Zeichen), Maus, Mauspad, Tastatur, Monitor, DPI, In-game- und
Scoped-Sensitivity (je 120 Zeichen), Crosshair (500) und weitere Settings (1000).
Die Anzeige erfolgt als Text, ohne HTML-Auswertung oder externe Einbettungen.

`supabase/migrations/20261013200000_profile_bio_and_setup.sql` vollständig nach
den bisherigen Migrationen ausführen. Es ist kein Edge-Function-Update nötig.
Erst danach das Frontend veröffentlichen.

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
