# Stat-Medaillen auf dem Spielerprofil

Gold, Silber und Bronze kennzeichnen die drei höchsten angezeigten Werte
jeweils für K/D, Accuracy, Crouches/min und Pace (Kills pro Minute).
Berücksichtigt werden nur platzierte Spieler mit mindestens 10 vollständig
eligible Matches und gültiger ELO. Die Rangliste bleibt nach ELO/PB sortiert.

Gleichstände teilen sich eine Medaille: Der höchste Wert bekommt Gold, der
nächste unterschiedliche Wert Silber und der dritte Bronze. Dadurch können
mehr als drei Spieler eine Medaille pro Kategorie tragen. Verglichen wird die
angezeigte Präzision: zwei Dezimalstellen für K/D, Accuracy und KPM, eine für
Crouches/min. Fehlende, ungültige oder Nullwerte verdienen keine Medaille.

Crouches/min wird aus den gesamten Crouches geteilt durch die gesamte persönliche
Spielzeit in Minuten berechnet, wie auf dem Profil. Die anderen Kategorien
verwenden die bestehenden allgemeinen Profil-Stats, nicht die ELO-gewichteten
Durchschnitte. Suche und Pagination verändern die Vergabe nicht; Grundlage
ist immer die vollständige platzierte Rangliste.

Auf jedem Spielerprofil erscheinen gewonnene metallische SVG-Medaillen direkt
neben dem Wert in den Karten Avg K/D, Avg Accuracy, Avg Pace und Crouches/min.
Die Darstellung gilt auf Desktop und Mobil. Numerische Kennzeichnung und
Beschreibung/Tooltip zeigen die globale Kategorie und die Medaillenfarbe.
Im Leaderboard werden keine Medaillen angezeigt; die zusätzlich eingeführte
Crouches-Spalte und die Medaillen-Legende wurden vollständig zurückgenommen.

Nur Frontend-Änderungen. Die bestehenden `players`-Felder genügen; es werden
keine neuen Daten gespeichert. Die bestehende Profil-Rangabfrage lädt zusätzlich
die Stat-Felder und bei mehr als 1.000 platzierten Spielern weitere Seiten,
damit die Vergabe die vollständige platzierte Population berücksichtigt.
Kein SQL- oder Edge-Function-Update erforderlich.

249 Tests, TypeScript und Produktions-Build bestanden. Die sechs neuen Tests
decken unabhängige Kategorien, Gleichstände, den zeitgewichteten Crouch-Wert,
fehlende Stats, Placements, globale Vergabe bei Suche/Pagination und zugängliche
Medaille-Beschreibungen ab. Eine direkte visuelle Browserprüfung war nicht möglich,
weil der Codex-Browser die lokale Vorschau nicht erreichen konnte.
