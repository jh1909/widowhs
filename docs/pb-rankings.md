# PB, Rangfolge und Record Holder

Die Rangliste sortiert nach ELO absteigend, danach nach PB aufsteigend. Spieler
ohne gültige PB folgen bei gleicher ELO hinter Spielern mit PB. Bei identischer
ELO und PB bleibt der bisherige alphabetische Vergleich als letzte Entscheidung.
Die angezeigten Ränge werden vor Suche und Pagination berechnet. Die Startseite
und Profil-Rangberechnung berücksichtigen weiterhin nur Spieler mit 10+ Matches.

Eine PB ist die kleinste positive `time_in_lobby` eines gespeicherten Matches
mit mindestens 50 Kills. `total_match_time` gehört nicht zu dieser Berechnung.
Der Record Holder wird aus allen erfassten Spielern gewählt, einschließlich
Spielern in Placements und importierten Spielern ohne Discord-Verknüpfung.
Bei gleich schnellen Rekorden wird ein Name alphabetisch als erster angezeigt.

## Datenbank

`supabase/migrations/20261013180000_pb_rankings_and_records.sql` nach
`20261013140000_verified_battlenet_claim_priority.sql` vollständig ausführen.
Die Migration füllt `players.personal_best_time` aus bestehenden Matches und
synchronisiert diesen Wert bei Match-Import, Änderung, Übertragung und Löschung.
Browser können keine PB vergeben; Schreibversuche werden aus den tatsächlichen
Gewinn-Matches neu berechnet. Private Pflegefunktionen sind nicht als RPC für
Browser oder `service_role` aufrufbar.

Die bisherigen Import- und OAuth-RPC-Signaturen bleiben kompatibel. Der Server
korrigiert die Rangfolge und neue History-Einträge auch dann, wenn eine ältere
`upload-csv`-Edge-Function noch keine PB mitberechnet. Für diese Änderung muss
keine Edge Function erneut deployed werden. Frühere Migrationen nicht nach der
neuen PB-Migration erneut installieren, da sie Funktionsdefinitionen ersetzen.

Nach einem Reset sind PBs und Record Holder leer. Ein Unlink entfernt die PB
nicht, da die Match History beim ursprünglichen Profil bleibt. Eine erfolgreiche
Zusammenführung übernimmt die schnellste PB der zugehörigen Matches.

Die Podium-Zeilen verwenden dieselben Saphir-/Rubin-/Smaragd-Farben wie die
Profilrahmen, mit schwächerem Hintergrund und einer dünnen Goldkontur.
