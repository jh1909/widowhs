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
        <p className="text-xs text-zinc-500 mb-8">Stand: 5. Oktober 2026</p>
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

          <h2>4. Öffentliche Spielstatistiken</h2>
          <p>Spielernamen und Matchstatistiken stammen aus den vom Betreiber importierten WIDOW-HS-Spieldateien. Verarbeitet werden unter anderem Kills, Deaths, Genauigkeit, KPM, KDR, Crouches, Lobbyzeit und Matchdauer. Daraus entstehen ELO, Rang und Verlauf. Wenn du Battle.net-Namen mit deinem Profil verknüpfst, werden die passenden Matchdaten diesem Profil zugeordnet.</p>
          <p>Dein Anzeigename, deine Statistiken und dein Verlauf sind öffentlich sichtbar. Für selbst angeforderte Profilfunktionen gilt Art. 6 Abs. 1 lit. b DSGVO. Die Zuordnung importierter Spielergebnisse und die Community-Rangliste beruhen auf Art. 6 Abs. 1 lit. f DSGVO: dem Interesse an nachvollziehbaren Spielergebnissen und vergleichbaren Statistiken. Gegen eine Verarbeitung auf dieser Grundlage kannst du Widerspruch einlegen.</p>
          <p>ELO wird automatisch aus Spielwerten berechnet. Diese Rangfolge hat keine rechtlichen oder vergleichbar erheblichen Auswirkungen auf dich.</p>

          <h2>5. Speicherung und Löschung</h2>
          <p>Profile, verknüpfte Accountnamen und Matchverläufe bleiben gespeichert, solange sie für das von dir genutzte Spielerprofil beziehungsweise das fortbestehende Statistikangebot erforderlich sind. Du kannst die Löschung per E-Mail anfragen. Entfällt der Verarbeitungszweck oder greift dein Löschrecht, werden die betroffenen personenbezogenen Daten gelöscht oder wirksam anonymisiert, soweit keine gesetzliche Pflicht oder ein anderer rechtmäßiger Aufbewahrungsgrund entgegensteht.</p>
          <p>Ein bloßer Logout löscht dein Profil nicht. Technische Protokolle und Sicherungskopien der Dienstleister unterliegen deren Aufbewahrungs- und Löschregeln. Für sie gelten die jeweiligen Sicherheits-, Betriebs- und gesetzlichen Erfordernisse; die Anbieterinformationen sind unten verlinkt.</p>

          <h2>6. Sitzungsspeicher und externe Dienste</h2>
          <p>Supabase Auth nutzt den lokalen Browserspeicher, um deine angeforderte Anmeldung aufrechtzuerhalten. Dieser technisch notwendige Zugriff dient der Kontofunktion (§ 25 Abs. 2 Nr. 2 TDDDG). Du kannst dich ausloggen oder den Browserspeicher löschen. Die Website bindet keine Werbe- oder Analysewerkzeuge und keine extern geladenen Schriftarten ein.</p>
          <p>Discord-Links öffnen eine externe Website erst beim Anklicken. Für die dortige Verarbeitung gelten die Hinweise von Discord. Öffentliche Profilbilder werden hier durch lokal dargestellte Initialen ersetzt.</p>

          <h2>7. Empfänger und Verarbeitung außerhalb der EU</h2>
          <p>Empfänger sind GitHub für das Hosting, Supabase für Datenbank und Anmeldung sowie Discord beim gewählten Login oder beim Besuch verlinkter Discord-Seiten. Öffentlich dargestellte Profil- und Statistikdaten sind außerdem für Websitebesucher zugänglich. Auch bei einer EU-Datenbankregion können die beteiligten Anbieter Daten außerhalb der EU verarbeiten, etwa für ihre globale Infrastruktur und Unterstützung.</p>
          <p>Die Anbieter beschreiben ihre Übermittlungen und Schutzmaßnahmen in ihren Datenschutzinformationen. GitHub nennt insbesondere Standardvertragsklauseln und das EU-US Data Privacy Framework; Supabase nennt Standardvertragsklauseln. Details und Kontaktmöglichkeiten findest du bei <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" target="_blank" rel="noopener noreferrer">GitHub</a>, <a href="https://supabase.com/privacy" target="_blank" rel="noopener noreferrer">Supabase</a> und <a href="https://discord.com/privacy" target="_blank" rel="noopener noreferrer">Discord</a>.</p>

          <h2>8. Deine Rechte</h2>
          <p>Unter den gesetzlichen Voraussetzungen hast du Rechte auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung und Datenübertragbarkeit. Gegen eine Verarbeitung aufgrund berechtigter Interessen kannst du Widerspruch einlegen. Soweit eine Verarbeitung auf Einwilligung beruht, kannst du diese für die Zukunft widerrufen.</p>
          <p>Du kannst dich außerdem bei einer Datenschutzaufsichtsbehörde beschweren, insbesondere am Ort deines Aufenthalts oder des vermuteten Verstoßes. Für den Betreiber in Baden-Württemberg ist der <a href="https://www.baden-wuerttemberg.datenschutz.de/" target="_blank" rel="noopener noreferrer">Landesbeauftragte für den Datenschutz und die Informationsfreiheit Baden-Württemberg</a> zuständig.</p>
        </div>
      </article>
    </main>
  );
}
