import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import OperatorContact from "../components/OperatorContact";

export default function PrivacyPolicy() {
  return (
    <main className="page-shell legal-page space-y-7">
      <Link to="/" className="inline-flex items-center gap-2 text-xs text-zinc-500 hover:text-toxic-purple"><ArrowLeft size={14} /> Back to leaderboard</Link>
      <article className="panel p-7 sm:p-10">
        <p className="eyebrow mb-4">WIDOW HS · Deine Daten</p>
        <h1 className="section-heading mb-3">Datenschutzhinweise</h1>
        <p className="text-xs text-zinc-500 mb-8">Stand: 13. Oktober 2026</p>
        <div className="legal-copy">
          <p>WIDOW HS ist eine öffentliche Community-Rangliste. Du kannst sie ohne Anmeldung ansehen. Für dein eigenes Profil und die Verknüpfung von Battle.net-Namen ist eine freiwillige Anmeldung über Discord möglich.</p>

          <h2>1. Verantwortlicher und Kontakt</h2>
          <OperatorContact />
          <p className="mt-4">Für Auskunft, Berichtigung, Widerspruch oder eine Löschanfrage erreichst du den Betreiber per E-Mail.</p>

          <h2>2. Website und Datenbank</h2>
          <p>Die Website wird über GitHub Pages von GitHub bereitgestellt. Beim Abruf erhält GitHub technische Verbindungsdaten, insbesondere deine IP-Adresse. GitHub speichert IP-Adressen von Pages-Besuchern zu Sicherheitszwecken. Grundlage für die Bereitstellung und Absicherung dieser Website ist Art. 6 Abs. 1 lit. f DSGVO: das berechtigte Interesse an einem funktionsfähigen und sicheren Angebot.</p>
          <p>Supabase wird für Anmeldung, Datenbank und den Import von Spielstatistiken eingesetzt. Das Datenbankprojekt wird nach der Konfiguration des Betreibers in der EU betrieben. Bei Verbindungen zu Supabase fallen ebenfalls technische Verbindungsdaten an. Die Datenbank enthält die unten beschriebenen Profil- und Statistikdaten.</p>

          <h2>3. Freiwilliger Discord-Login</h2>
          <p>Bei der Anmeldung werden die von Discord freigegebenen Kontoinformationen durch Supabase Auth verarbeitet. Dazu können Discord-ID, Benutzername, E-Mail-Adresse und Avatar-URL gehören. Das Profil wird mit einer internen Benutzer-ID verknüpft. Discord-Passwörter werden nicht an WIDOW HS übermittelt. Die E-Mail-Adresse wird nicht in der Rangliste angezeigt.</p>
          <p>Die Verarbeitung für die von dir angeforderten Kontofunktionen erfolgt nach Art. 6 Abs. 1 lit. b DSGVO. Die Angabe der erforderlichen Kontodaten ist freiwillig; ohne sie kannst du diese Kontofunktionen nicht nutzen. Die öffentliche Rangliste bleibt ohne Anmeldung erreichbar.</p>
          <p>Du kannst zusätzlich freiwillig ein Battle.net-Konto über Blizzard verbinden. Die Anmeldung und Freigabe erfolgen auf Blizzards Website. WIDOW HS erhält die Battle.net-Account-ID und den vollständigen BattleTag, um das Konto deinem Discord-Profil zuzuordnen und seine Kontrolle zu verifizieren. Der BattleTag und der Verifizierungsstatus werden öffentlich im Profil angezeigt; die interne Battle.net-Account-ID bleibt geschützt. Blizzard-Passwörter erhält WIDOW HS nicht. Der Zugriffstoken wird nur während der Verknüpfung verwendet und nicht dauerhaft gespeichert. Die Verknüpfung kann im Profil entfernt werden; vorhandene Matchstatistiken bleiben erhalten. Für diese angeforderte Kontofunktion gilt ebenfalls Art. 6 Abs. 1 lit. b DSGVO.</p>

          <h2>4. Öffentliche Spielstatistiken</h2>
          <p>Spielernamen und Matchstatistiken stammen aus den vom Betreiber importierten WIDOW-HS-Spieldateien. Verarbeitet werden unter anderem Kills, Deaths, Genauigkeit, KPM, KDR, Crouches, Lobbyzeit und Matchdauer. Daraus entstehen ELO, Rang und Verlauf. Wenn du Battle.net-Namen mit deinem Profil verknüpfst, werden die passenden Matchdaten diesem Profil zugeordnet.</p>
          <p>Importierte Runden enthalten auch die Spielernamen und Ergebnisse von Teilnehmern ohne Website-Account. Diese werden in der Rangliste und der globalen Match-History angezeigt. Datum, Rundendauer und die Einzelwerte aller gespeicherten Teilnehmer einer Runde sind öffentlich abrufbar. Eine spätere Account-Verknüpfung führt die passenden bisherigen Ergebnisse mit dem Discord-Profil zusammen. „Verified“ zeigt an, dass mindestens ein zum Discord-Profil gehörendes Battle.net-Konto durch eine Anmeldung bei Blizzard bestätigt wurde. Da die Workshop-Dateien nur Namen ohne eindeutige Account-ID enthalten, wird ein bereits beanspruchter Spielername nicht an einen anderen Nutzer vergeben.</p>
          <p>Dein Anzeigename, deine Statistiken und dein Verlauf sind öffentlich sichtbar. Für selbst angeforderte Profilfunktionen gilt Art. 6 Abs. 1 lit. b DSGVO. Die Zuordnung importierter Spielergebnisse und die Community-Rangliste beruhen auf Art. 6 Abs. 1 lit. f DSGVO: dem Interesse an nachvollziehbaren Spielergebnissen und vergleichbaren Statistiken. Gegen eine Verarbeitung auf dieser Grundlage kannst du Widerspruch einlegen.</p>
          <p>ELO wird automatisch aus Spielwerten berechnet. Diese Rangfolge hat keine rechtlichen oder vergleichbar erheblichen Auswirkungen auf dich.</p>
          <p>Du kannst freiwillig eine kurze Bio sowie Angaben zu Maus, Mauspad, Tastatur, Bildschirm und Spieleinstellungen ergänzen. Diese Angaben sind öffentlich auf deinem Profil sichtbar und an dein Discord-Konto gebunden. Du kannst sie im Profil jederzeit ändern oder durch Leeren der Felder entfernen.</p>
          <p>Administratoren können Bio- und Setup-Angaben zur Moderation bearbeiten oder entfernen. Solche Änderungen werden mit dem handelnden Administrator und dem betroffenen Profil protokolliert; entfernte Inhalte werden nicht in dieses Protokoll übernommen.</p>

          <h2>5. Speicherung und Löschung</h2>
          <p>Profile, verknüpfte Accountnamen und Matchverläufe bleiben gespeichert, solange sie für das von dir genutzte Spielerprofil beziehungsweise das fortbestehende Statistikangebot erforderlich sind. Du kannst die Löschung per E-Mail anfragen. Entfällt der Verarbeitungszweck oder greift dein Löschrecht, werden die betroffenen personenbezogenen Daten gelöscht oder wirksam anonymisiert, soweit keine gesetzliche Pflicht oder ein anderer rechtmäßiger Aufbewahrungsgrund entgegensteht.</p>
          <p>Ein bloßer Logout löscht dein Profil nicht. Technische Protokolle und Sicherungskopien der Dienstleister unterliegen deren Aufbewahrungs- und Löschregeln. Für sie gelten die jeweiligen Sicherheits-, Betriebs- und gesetzlichen Erfordernisse; die Anbieterinformationen sind unten verlinkt.</p>

          <h2>6. Sitzungsspeicher und externe Dienste</h2>
          <p>Supabase Auth nutzt den lokalen Browserspeicher, um deine angeforderte Anmeldung aufrechtzuerhalten. Dieser technisch notwendige Zugriff dient der Kontofunktion (§ 25 Abs. 2 Nr. 2 TDDDG). Du kannst dich ausloggen oder den Browserspeicher löschen. Die Website bindet keine Werbe- oder Analysewerkzeuge und keine extern geladenen Schriftarten ein.</p>
          <p>Für eine angeforderte Battle.net-Verknüpfung wird ein zufälliger Prüfwert vorübergehend im Sitzungsspeicher des Browser-Tabs hinterlegt. Er bindet die Rückkehr von Blizzard an den Browser und das Discord-Konto, die die Verknüpfung gestartet haben, und wird nach Abschluss entfernt. Serverseitige Login-Vorgänge und noch nicht bestätigte Battle.net-Angaben laufen nach zehn Minuten je Schritt ab und werden spätestens bei weiteren Verknüpfungsversuchen gelöscht.</p>
          <p>Discord-Profilbilder werden, soweit verfügbar, von den Discord-Bildservern geladen. Dabei erhält Discord technische Verbindungsdaten, insbesondere deine IP-Adresse. Die Einbindung dient der Darstellung und Wiedererkennung von Community-Profilen und beruht auf Art. 6 Abs. 1 lit. f DSGVO. Es wird kein Referer mitgesendet. Fehlt ein Bild oder kann es nicht geladen werden, erscheinen Initialen.</p>
          <p>Discord-Links öffnen eine externe Website erst beim Anklicken. Für die Verarbeitung durch Discord gelten die unten verlinkten Datenschutzhinweise von Discord.</p>

          <h2>7. Empfänger und Verarbeitung außerhalb der EU</h2>
          <p>Empfänger sind GitHub für das Hosting, Supabase für Datenbank und Anmeldung, Discord beim Laden von Profilbildern, beim gewählten Login oder beim Besuch verlinkter Discord-Seiten sowie Blizzard bei einer von dir gestarteten Battle.net-Verknüpfung. Dabei erhält Blizzard insbesondere technische Verbindungsdaten und die Anfrage zur Kontofreigabe. Für Blizzards Verarbeitung gelten die <a href="https://www.blizzard.com/en-us/legal/41e60b3d-244d-4776-be75-e2c6b3eba9a3/blizzard-entertainment-privacy-policy" target="_blank" rel="noopener noreferrer">Datenschutzhinweise von Blizzard</a>. Öffentlich dargestellte Profil- und Statistikdaten sind außerdem für Websitebesucher zugänglich. Auch bei einer EU-Datenbankregion können die beteiligten Anbieter Daten außerhalb der EU verarbeiten, etwa für ihre globale Infrastruktur und Unterstützung.</p>
          <p>Die Anbieter beschreiben ihre Übermittlungen und Schutzmaßnahmen in ihren Datenschutzinformationen. GitHub nennt insbesondere Standardvertragsklauseln und das EU-US Data Privacy Framework; Supabase nennt Standardvertragsklauseln. Details und Kontaktmöglichkeiten findest du bei <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" target="_blank" rel="noopener noreferrer">GitHub</a>, <a href="https://supabase.com/privacy" target="_blank" rel="noopener noreferrer">Supabase</a> und <a href="https://discord.com/privacy" target="_blank" rel="noopener noreferrer">Discord</a>.</p>

          <h2>8. Deine Rechte</h2>
          <p>Unter den gesetzlichen Voraussetzungen hast du Rechte auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung und Datenübertragbarkeit. Gegen eine Verarbeitung aufgrund berechtigter Interessen kannst du Widerspruch einlegen. Soweit eine Verarbeitung auf Einwilligung beruht, kannst du diese für die Zukunft widerrufen.</p>
          <p>Du kannst dich außerdem bei einer Datenschutzaufsichtsbehörde beschweren, insbesondere am Ort deines Aufenthalts oder des vermuteten Verstoßes. Für den Betreiber in Baden-Württemberg ist der <a href="https://www.baden-wuerttemberg.datenschutz.de/" target="_blank" rel="noopener noreferrer">Landesbeauftragte für den Datenschutz und die Informationsfreiheit Baden-Württemberg</a> zuständig.</p>
        </div>
      </article>
    </main>
  );
}
