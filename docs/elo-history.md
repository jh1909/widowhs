# Öffentlicher ELO-Verlauf

Uploads speichern bereits ELO-Snapshots in `player_history`. Im Live-Projekt
gab es dafür nur eine INSERT-Policy, keine SELECT-Policy. Der bisherige direkte
Tabellenabruf im Profil lieferte deshalb keine Punkte; das Profil ersetzte die
fehlenden Daten durch einen einzelnen, nicht gespeicherten aktuellen ELO-Punkt.

`20261013210000_public_elo_history.sql` ergänzt einen lesenden RPC
`get_player_elo_history(p_player_name)`. Er liefert nur ELO und Zeitpunkt für
existierende Spieler, begrenzt auf die neuesten 30 gespeicherten Updates und
chronologisch sortiert. Die Tabellenpolicies werden nicht geändert. Migration
vor dem Frontend-Deployment ausführen; kein Edge-Function-Update nötig.

Im Live-Projekt `kzymescftenxuspjsssh` am 13. Oktober 2026 installiert und
mit dem öffentlichen Frontend-Key geprüft: HTTP 200, 13 echte Punkte für
`prx` (12 verschiedene Ratings) und 30 für `Klog` (26 verschiedene Ratings).
Der gespeicherte read-only SQL-Nachweis ist unter
https://supabase.com/dashboard/project/kzymescftenxuspjsssh/sql/b2fa40c5-1b11-4117-a7bb-631f675794f5
abrufbar. Das aktualisierte Frontend benötigt noch den Push auf `main`.

Das Profil verwendet ausschließlich gespeicherte Punkte, zeigt Abruffehler
mit einem Retry und zeigt einen einzelnen vorhandenen Punkt als sichtbaren
Dot. Der Tooltip enthält Datum und Uhrzeit in Europe/Berlin. Die Beschriftung
lautet „Latest 30 updates“, da die Anzahl von Punkten begrenzt wird und kein
Filter für 30 Tage besteht.

Ein Snapshot beschreibt eine abgeschlossene Aktualisierung der kumulierten
ELO. Bei einem Upload mit mehreren Dateien existiert bisher ein Snapshot pro
betroffenem Spieler für den gesamten Upload. Auch Verknüpfungen, die die
Statistiken zusammenführen, können einen Snapshot schreiben. Die Darstellung
erfindet keine früheren Zwischenstände und berechnet die vorhandene ELO nicht neu.
