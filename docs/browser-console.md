# Browser-Konsole

## Firefox: Supabase Auth-Sperre

Der automatische Token-Refresh versucht die Auth-Sperre ohne Wartezeit zu
erhalten. Ist sie durch die Initialisierung oder einen anderen Tab belegt,
soll der Versuch übersprungen werden. Die SDK-Implementierung wirft dabei
innerhalb des Web-Locks-Callbacks eine Timeout-Exception. Firefox kann diese
Callback-Rejection separat melden, obwohl der Refresh den Timeout abfängt.

`src/lib/auth-lock.ts` gibt bei diesem Fall ein normales Ergebnis aus dem
Browser-Callback zurück und erzeugt den vom SDK erwarteten Timeout erst danach.
Die gesperrte Operation läuft dabei nicht. Alle wartenden Auth-Operationen
verwenden unverändert `navigatorLock` mit seinen Timeout- und Recovery-Regeln.
Die Koordination zwischen Tabs, Session-Speicherung und automatische Erneuerung
bleiben aktiv. Echte Fehler werden weiterhin weitergereicht.

Der Auth-Callback aktualisiert nur React-State. `ensure_discord_player` läuft
anschließend in einem eigenen Effect, mit Schutz gegen Ergebnisse nach Logout
oder Benutzerwechsel. Fehlgeschlagene Profilabfragen können beim nächsten
Auth-Event erneut versucht werden. `INITIAL_SESSION` übernimmt die Wiederherstellung
des bestehenden Logins; eine zusätzliche gleichzeitige `getSession`-Abfrage entfällt.
Siehe [Supabase-Hinweise zu Auth-Callbacks](https://supabase.com/docs/reference/javascript/auth-onauthstatechange).

Getestet mit simulierten Web Locks und dem installierten Auth-SDK: Belegte Sperre
führt zu keinem abgewiesenen Browser-Callback, Operationen werden serialisiert,
echte Fehler werden weitergereicht und der nächste freie Refresh erneuert das Token.
Es wurde kein direkter Firefox-/Brave-Test durchgeführt.

## Favicon

`public/favicon.svg` ist im HTML ausdrücklich verknüpft. `public/favicon.ico`
dient als Fallback und beantwortet auch direkte automatische ICO-Abfragen.
Relative Vite-Assetpfade unterstützen die eigene Domain und GitHub Pages.

## Chrome und Brave

`__chromium_devtools_metrics_reporter` ist eine Binding-Funktion des von Chrome
DevTools injizierten Web-Vitals-Codes, kein Bestandteil des Website-Bundles.
Bei einem solchen Fehler DevTools schließen, die Seite neu laden und DevTools
wieder öffnen. [Chromium-Quellcode](https://chromium.googlesource.com/devtools/devtools-frontend/+/d7c0c011fcf86697f24c04bd4846af35442e0cdd%5E%21/)

Warnungen über unbekannte `Permissions-Policy`-Features betreffen die jeweiligen
nicht unterstützten APIs. Die Website verwendet die genannten Werbe-APIs nicht.
Beim HTTP-Abruf am 13. Oktober 2026 enthielten weder die Hauptseite noch das
ausgelieferte JS-Bundle einen solchen Header; die genaue auslösende Ressource
im gemeldeten Brave-Browser ist damit nicht bestimmt.

Für diese Änderungen genügt der Frontend-Push. Supabase-Funktionen und SQL
müssen nicht aktualisiert werden.
