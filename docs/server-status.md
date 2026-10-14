# Gemessener Serverstatus

Admin → Server Status prüft die Erreichbarkeit der Datenbank aus dem aktuellen
Browser mit einer echten `players`-Abfrage. Erfolg setzt einen HTTP-2xx-Status
ohne Supabase-Fehler voraus. Eine langsame erfolgreiche Abfrage bleibt
„Reachable“; ihre vollständige Dauer wird separat mit `performance.now()`
gemessen. Die alte pauschale 200-ms-„Degraded“-Regel entfällt.

Die Anzeige unterscheidet „Not checked yet“, „Checking“, „Reachable“,
„Browser offline“, „Timed out“, „Access denied“ (401/403) und „Request failed“.
Die letzten Check-/Erfolgszeitpunkte und der HTTP-Status kommen aus echten
Ergebnissen. Erfolgreiche und insgesamt abgeschlossene gemessene Abfragen
werden nur für den aktuellen Besuch gezählt. Offline-Meldungen ohne Anfrage
und abgebrochene Checks werden dabei nicht mitgezählt.

Checks laufen ohne Überschneidung, regulär 15 Sekunden nach Abschluss des
vorherigen Checks. Sie pausieren bei verborgenem Tab, reagieren auf erneute
Sichtbarkeit und Online-/Offline-Ereignisse und können manuell ausgelöst werden.
Ein 10-Sekunden-Timeout begrenzt auch eine blockierte SDK-Session-Abfrage vor
dem eigentlichen Fetch. Abbruch und Timeout werden an PostgREST weitergegeben;
späte Antworten ändern die Anzeige nicht.

Spieler-, Bann- und Audit-Zähler werden etwa jede Minute nach einem erfolgreichen
Check oder auf manuelle Anforderung per HEAD/Exact-Count aktualisiert. Jede
Antwort wird geprüft. Tatsächliche 0 bleibt 0; fehlende, ungültige und fehlgeschlagene
Counts erscheinen als „—“ mit Fehlermeldung. Der Zeitpunkt der letzten Zählabfrage
ist sichtbar. Die Werte respektieren die Datenbankberechtigungen der Sitzung;
sie werden deshalb ausdrücklich als zugängliche Datensätze bezeichnet.

Region und „99,99 % Uptime“ wurden entfernt, da sie bisher fest eingetragen waren.
Diese Browser-Messungen können keine durchgängige oder globale Service-Uptime
feststellen. Für den allgemeinen Providerstatus gibt es einen Link zu
`https://status.supabase.com/`. Es werden keine zusätzlichen Zugangsdaten benötigt
und keine Monitoring-Daten in Supabase gespeichert.

Nur Frontend-Änderungen: kein SQL- oder Edge-Function-Update notwendig.
