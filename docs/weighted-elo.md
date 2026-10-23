# Gewichtete Teilnahme für ELO

Aktueller Stand: [Letzte 100 eligible Runden](recent-performance.md).
Die neue Migration begrenzt ELO und angezeigte Leistungswerte auf dieses Fenster.
Die folgende Dokumentation beschreibt die ursprüngliche Lifetime-Gewichtung.

Migration `20261013233000_weighted_elo_participation.sql` nach PB-Rankings und
täglichem ELO-Verlauf installieren, bevor das neue Frontend veröffentlicht wird.
Ein Update der Edge Functions ist dafür nicht erforderlich. Die aktualisierte
Import-Bibliothek berechnet dieselben Werte; die Datenbank bleibt maßgeblich und
korrigiert auch Payloads älterer Upload-Funktionen.

| Teilnahme | Gewicht |
| --- | --- |
| Join innerhalb der ersten 10 Sekunden (einschließlich) | 1 |
| Späterer Join, mindestens 35 Kills **oder** 180 Sekunden gespielt | 1 |
| Späterer Join, weniger als 15 Kills **und** weniger als 60 Sekunden gespielt | 0 |
| Übrige späte Joins | `min(1, max(kills / 35, seconds / 180))` |
| Alte Logs ohne Gesamtdauer | 1 |

Ein später Join bedeutet `total_match_time - time_in_lobby > 10`.
Für die Platzierung werden **10 vollständig eligible Matches** benötigt.
Nur ein Match mit Gewicht 1 zählt als ein Placement-Match. Reduzierte Matches
zählen nicht zu den Placements, auch wenn ihre ELO-Gewichte zusammen 1 ergeben.
`placement_matches` ist ein ganzzahliger, serverseitig abgeleiteter Zähler.
Die Korrektur `20261014010000_count_fully_eligible_placements.sql` muss nach der
Gewichtungs-Migration und vor Veröffentlichung des neuen Frontends installiert werden.
Allgemeine Stats und die Anzahl gespielter Matches erfassen weiterhin jede Teilnahme.

Die Profil-ELO verwendet jeweils `sum(stat * weight) / sum(weight)` für KPM,
Accuracy und KDR. Anschließend gilt unverändert die Formel:

```
pace = min(weightedKPM / 16.67, 1.67)
acc = min(weightedAccuracy / 60, 1.15)
kdr = min(weightedKDR, 4.0) / 3.0
elo = round((pace * .65 + acc * .25 + kdr * .10) * 1000)
```

Das rohe Rundenrating bleibt unverändert und wird in beiden Match-Ansichten
bei Bedarf mit „Ineligible“ oder „Reduced weighting“ samt Prozentwert versehen.
Eine vollständig ausgeschlossene Teilnahme beeinflusst weder ELO noch Placements
und erzeugt kein zusätzliches ELO-Sample im Tagesverlauf. Ohne jegliches
Teilnahmegewicht bleibt die Profil-ELO `-`.

Vorhandene Einzellogs werden rückwirkend gewichtet. Alte aggregierte Teilnahmen,
zu denen Einzellogs fehlen, bleiben mit Gewicht 1 erhalten. Ihr Restbeitrag liegt
in `player_elo_legacy`, einer privaten Tabelle ohne Browser-/Service-RPC-Zugriff.
Umbenennungen und vollständige Profil-Zusammenführungen erhalten diesen Beitrag.
Bei einer verifizierten Übernahme eines fremden manuellen Namens werden wie bisher
nur eindeutig zuordenbare Log-Zeilen übertragen, keine fremden Discord-Profile.
Der Admin-Reset leert auch diese Restbeiträge.

Bestehende tägliche ELO-Verläufe bleiben als damalige Bewertungen erhalten.
Die Installation erfasst einmal die neu berechnete Profil-ELO, sofern sie sich
ändert; der bestehende Tagesverlauf mittelt dieses Sample normal mit. Erneutes
Installieren ohne Datenänderung fügt kein weiteres Sample hinzu.

Gewichte sind aus den gespeicherten Matchdaten abgeleitet. Die vier öffentlichen
Summen auf `players` sind nur ein serverseitig gepflegter Cache; Browser dürfen
sie nicht wirksam überschreiben. Die privaten Pflegefunktionen bleiben gesperrt.
Die bisherigen Kontozuordnungs- und Admin-Prüfungen bleiben erhalten.

Am 13. Oktober 2026 live installiert und geprüft: 631 Spieler, 309 Runden und
1.773 Teilnahmen unverändert; 364 Teilnahmen mit reduziertem Gewicht, keine
ausgeschlossene Teilnahme. 22 ältere Teilnahmen ohne vollständige Logs bleiben
mit Gewicht 1 erhalten. Nach der damaligen, inzwischen korrigierten Placement-Regel
erreichten 31 Spieler mindestens 10 aufsummierte Teilnahmegewichte.
Rundenrating-Summe (744.697), Kills (48.604), PB-Anzahl (60), PB-Summe (23.572)
und die Prüfsumme der allgemeinen K/D-Werte sind unverändert. Cache-, ELO- und
Tagesmittel-Gegenprüfungen ergeben keine Abweichungen. Die Neukalibrierung erzeugte
125 neue Samples; der Tagesverlauf enthält jetzt 678 Zeilen mit 1.863 Samples.

239 Tests, TypeScript und Produktions-Build bestanden. Tests berücksichtigen
Fließkomma-Spielzeiten wie im Live-Schema und beide Account-Spaltentypen.
Die Frontend-Anzeige benötigt den Push auf `main`; die Datenbank ist bereits bereit.

Am 14. Oktober 2026 wurde die Placement-Korrektur live installiert. Der neue
Zähler zählt nur Matches mit Gewicht 1, einschließlich der als volle Matches
bewahrten Legacy-Teilnahmen. Der Abgleich aller 740 Profile ergibt keine
Zählerabweichungen; 33 Spieler haben mindestens 10 vollständig eligible Matches.
Die Prüfsummen aller bisherigen Spielerfelder und aller 788 ELO-Verlauf-Zeilen
blieben unverändert, ebenso die 2.206 Match-Teilnahmen. Beispiel: Yōkai hat
3 Placement-Matches, obwohl seine ELO-Gewichte zusammen etwa 3,51 betragen.
243 Tests, TypeScript, Build und die öffentliche Placement-Abfrage bestanden.
Für die Korrektur ist kein Edge-Function-Update erforderlich; die neue Anzeige
wird mit dem nächsten Frontend-Push veröffentlicht.
