import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import OperatorContact from "../components/OperatorContact";

export default function Imprint() {
  return (
    <main className="page-shell legal-page space-y-7">
      <Link to="/" className="inline-flex items-center gap-2 text-xs text-zinc-500 hover:text-toxic-purple"><ArrowLeft size={14} /> Back to leaderboard</Link>
      <section className="panel p-7 sm:p-10">
        <p className="eyebrow mb-4">WIDOW HS · Anbieterangaben</p>
        <h1 className="section-heading mb-7">Impressum</h1>
        <OperatorContact />
        <p className="legal-copy mt-7">WIDOW HS ist ein unabhängiges Community-Projekt. Es besteht keine offizielle Verbindung zu Blizzard Entertainment oder Discord. Die jeweiligen Spiel- und Markennamen gehören ihren Rechteinhabern.</p>
        <Link to="/privacy" className="inline-block text-toxic-purple text-xs mt-6 underline underline-offset-4">Informationen zum Datenschutz</Link>
      </section>
    </main>
  );
}
