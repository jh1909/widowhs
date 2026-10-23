# Letzte 100 eligible Runden

Vor dem Frontend-Deployment die Migration
`supabase/migrations/20261023120000_recent_100_performance.sql` nach den bisherigen
Migrationen installieren. Kein Update der Edge Function erforderlich: Die
Datenbank berechnet ELO und die neuen Caches aus gespeicherten Runden, auch wenn
ein älterer Importer noch lebenslange Durchschnittswerte sendet.

- Pro Spieler zählen die letzten 100 Teilnahmen mit `elo_weight > 0`, sortiert
  nach `played_at DESC, created_at DESC, id DESC`. Bei weniger Runden zählen alle
  verfügbaren eligible Teilnahmen. Ausgeschlossene Teilnahmen verbrauchen keinen
  Platz. Eine reduzierte Teilnahme verbraucht einen Platz und behält ihr Gewicht.
- Accuracy, Pace und K/D sind die auf zwei Stellen gerundeten, gewichteten
  Durchschnitte dieses Fensters. ELO verwendet dieselben ungerundeten Summen und
  die bestehende Formel. Die Statistik-Medaillen verwenden ebenfalls das Fenster.
- Crouches/Match und Crouches/Minute verwenden tatsächliche Crouches, Rundenanzahl
  und Spielzeit desselben Fensters; Spielzeit gewichtet die Minutenrate.
- PB, `matches`, Placements und Veteran bleiben lifetime. Die bisherigen
  lebenslangen Rohsummen bleiben für Imports und Account-Merges erhalten.
  Total Kills/Deaths werden im Profil und Kills in der Spielerrangliste entfernt.
- Nicht rekonstruierbare Legacy-Summen ohne Rundenlogs beeinflussen ELO und
  aktuelle Stats nicht mehr. Sie bleiben für die lebenslangen Placements erhalten.
- Sharpshooter zeigt die höchste aktuelle Stufe: I ab 40%, II ab 50%, III ab 60%.
- Speedrunner zeigt `speedrunner_count`: alle gespeicherten Siege mit mindestens
  50 Kills und `0 < total_match_time < 180` Sekunden, unabhängig vom Fenster und
  vom Match-History-Abfragelimit. Der Zähler steht als „×N“ am Achievement.

Imports, Korrekturen, Löschungen, Umbenennungen, Account-Transfers und Resets
aktualisieren die serverseitigen Felder automatisch. Direkt gesetzte Cachewerte
werden neu abgeleitet. Bestehende tägliche ELO-Samples bleiben erhalten; bei
geänderter ELO fügt die Migration einmal ein Neukalibrierungs-Sample hinzu.
Erneute Installation ohne Datenänderung erzeugt keine weiteren Samples.

Die Integrationsprüfungen in `tests/recent-performance.test.ts` verwenden lokales
PostgreSQL (PGlite) mit beiden Account-Spaltentypen und einschließlich der
Moderationsmigration. Die Migration wird dadurch lokal ausgeführt und geprüft;
dies installiert sie nicht in der produktiven Supabase-Datenbank.
