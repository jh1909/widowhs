# Täglicher ELO-Verlauf

`supabase/migrations/20261013230000_daily_average_elo_history.sql` nach den
bisherigen Migrationen installieren. Das Profil zeigt anschließend einen
Tagesdurchschnitt pro aktivem Kalendertag, mit Tagesgrenzen in Europe/Berlin.
An Tagen ohne gespeicherte ELO-Updates wird kein künstlicher Wert angelegt.
Angezeigt werden die neuesten 30 aktiven Tage in chronologischer Reihenfolge.

Ein Tageswert ist der arithmetische Mittelwert der gespeicherten Profil-ELO-
Updates dieses Tages, auf ganze ELO gerundet. Er ist kein Mittelwert der
einzelnen Rundenratings und ändert die ELO-Formel oder die Rangliste nicht.
Bei einem Upload mehrerer Dateien entsteht weiterhin ein ELO-Update pro
betroffenem Spieler für den gesamten Upload. Auch Zusammenführungen können
ELO-Updates erzeugen. Der Zeitpunkt ist der Zeitpunkt dieses Updates, nicht
das Spieldatum einer später importierten Log-Datei.

## Speicherung

In `player_history` verbleibt für einen Spieler/Tag ein Datensatz mit
`elo_sum` und `elo_samples`. Neue Inserts durch die vorhandenen Import- und
OAuth-RPCs werden automatisch darin zusammengefasst. Summe und Anzahl bleiben
ungerundet; ein weiteres Update berechnet so den echten Gesamtdurchschnitt,
statt bisherige gerundete Mittelwerte gleich zu gewichten.

Die Migration fasst auch bestehende Einzelpunkte zusammen und entfernt die
überzähligen Zeilen. Einzelwerte und Uhrzeiten innerhalb eines Tages lassen
sich danach nicht rekonstruieren. Match History, PB, Spielerstatistiken,
Kontoverknüpfungen und persönliche Profildaten werden nicht gelöscht.
PostgreSQL kann freigewordene Tabellenseiten für spätere Daten wiederverwenden;
die angezeigte physische Tabellengröße muss nach der Zusammenfassung nicht
sofort sinken.

Umbenennungen erhalten die Tageswerte. Account-Zusammenführungen kombinieren
überlappende Tage anhand ihrer tatsächlichen Summen und Anzahlen. Der vorhandene
Leaderboard-Reset entfernt die Tageswerte und neue Updates beginnen mit einer
frischen Summe/Anzahl. Die Migration kann erneut installiert werden, ohne
bestehende Summen oder Anzahlen zurückzusetzen.

## Berechtigungen und Deployment

Der vorhandene `get_player_elo_history`-RPC behält seine Signatur und gibt nur
ELO und das Tagesdatum als Zeitstempel zur lokalen Mitternacht zurück. Die
Anzeige wertet dieses Datum in Europe/Berlin aus. Bestehende RLS-Leseregeln
bleiben erhalten. Direkte Browser-Schreibrechte auf `player_history` werden
entzogen; die geprüften serverseitigen Import- und Konto-RPCs schreiben weiter.
Private Pflegefunktionen können Browser und `service_role` nicht als RPC aufrufen.

Kein Edge-Function-Update nötig. Die neue Migration muss vor dem Frontend-Push
installiert werden. Für die Live-Zusammenfassung ist eine Bestätigung nötig,
weil sie die bisherigen Einzelpunkte dauerhaft durch Tageswerte ersetzt.

Die Live-Vorschau vom 13. Oktober 2026 ergibt 1.713 bisherige Einträge und
634 Spieler/Tageswerte. Für `prx` ergeben die 13 Updates am 13. Oktober einen
gerundeten Tagesdurchschnitt von 640 ELO. 221 Tests, TypeScript und Build
bestanden. Nach ausdrücklicher Bestätigung wurde die Migration am selben Tag
live installiert: 634 Tageszeilen mit unverändert 1.713 berücksichtigten
Samples und einer ELO-Summe von 715.092. Es bestehen keine doppelten Spieler/
Tag-Zeilen oder Abweichungen der Mittelwerte. Die 621 Spieler und 1.748
Match-Einträge blieben erhalten. Der öffentliche API-Abruf liefert für `prx`
einen Tageswert (640) und für `Klog` drei Tageswerte (675, 705, 732).
Das neue Frontend benötigt noch den Push auf `main`.
