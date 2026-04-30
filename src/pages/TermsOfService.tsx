import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";

export default function TermsOfService() {
  return (
    <main className="flex-grow w-full max-w-[800px] mx-auto px-6 py-12 flex flex-col gap-8">
      <Link to="/" className="inline-flex items-center gap-2 text-on-surface-variant hover:text-[#9d4edd] transition-colors duration-200 ease-out font-mono font-medium text-[14px]">
        <ArrowLeft className="w-[18px] h-[18px]" />
        Back to Leaderboard
      </Link>

      <div className="bg-surface-container/30 backdrop-blur-[12px] border border-[#4d4353] rounded-xl p-8 md:p-12">
        <h1 className="font-sans text-3xl font-extrabold tracking-tight text-on-surface mb-6">Terms of Service</h1>
        
        <div className="prose prose-invert prose-purple max-w-none font-sans text-on-surface-variant space-y-6">
          <p>Last updated: {new Date().toLocaleDateString('en-US')}</p>

          <h2 className="text-xl font-bold text-on-surface mt-8 mb-4">1. Scope</h2>
          <p>
            These Terms of Service apply to the use of the website and services of WIDOW HS. (hereinafter "Service" or "we"). By accessing our Service, you agree to these terms.
          </p>

          <h2 className="text-xl font-bold text-on-surface mt-8 mb-4">2. Service Description</h2>
          <p>
            Our Service provides a leaderboard and statistics platform for players. We reserve the right to modify, suspend, or discontinue the Service at any time.
          </p>

          <h2 className="text-xl font-bold text-on-surface mt-8 mb-4">3. Registration and Discord Account</h2>
          <p>
            Logging in via Discord is required for certain features of the Service. You are responsible for keeping your Discord account credentials secure. We are not liable for damages resulting from unauthorized access to your Discord account.
          </p>

          <h2 className="text-xl font-bold text-on-surface mt-8 mb-4">4. Rules of Conduct</h2>
          <p>
            Using the Service for illegal or unauthorized purposes is prohibited. It is forbidden to use cheats, exploits, automation software, bots, hacks, mods, or any other unauthorized third-party software to manipulate the Service, leaderboards, or statistics.
          </p>

          <h2 className="text-xl font-bold text-on-surface mt-8 mb-4">5. Limitation of Liability</h2>
          <p>
            We are only liable for intent and gross negligence. For slight negligence, we are only liable in case of a breach of substantial contractual obligations. The Service is provided "as is" and without any express or implied warranties.
          </p>

          <h2 className="text-xl font-bold text-on-surface mt-8 mb-4">6. Changes to the Terms of Service</h2>
          <p>
            We reserve the right to change these Terms of Service at any time. We will inform users in advance about significant changes.
          </p>
        </div>
      </div>
    </main>
  );
}
