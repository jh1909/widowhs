import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";

export default function PrivacyPolicy() {
  return (
    <main className="flex-grow w-full max-w-[800px] mx-auto px-6 py-12 flex flex-col gap-8">
      <Link to="/" className="inline-flex items-center gap-2 text-on-surface-variant hover:text-[#9d4edd] transition-colors duration-200 ease-out font-mono font-medium text-[14px]">
        <ArrowLeft className="w-[18px] h-[18px]" />
        Back to Leaderboard
      </Link>

      <div className="bg-surface-container/30 backdrop-blur-[12px] border border-[#4d4353] rounded-xl p-8 md:p-12">
        <h1 className="font-sans text-3xl font-extrabold tracking-tight text-on-surface mb-6">Privacy Policy</h1>
        
        <div className="prose prose-invert prose-purple max-w-none font-sans text-on-surface-variant space-y-6">
          <p>
            The party responsible for data processing, in particular regarding the EU General Data Protection Regulation (GDPR), is:<br />
            Jerome Hestin<br />
            Gartenstr. 17<br />
            j.hestin19&#64;gmail.com<br />
          </p>

          <h2 className="text-xl font-bold text-on-surface mt-8 mb-4">1. Collection of general information when visiting our website</h2>
          <p>
            When you access our website, i.e., if you do not register or otherwise submit information, information of a general nature is automatically collected. This information (server log files) includes, for example, the type of web browser, the operating system used, the domain name of your Internet service provider, your IP address, and similar information.
          </p>
          <p>
            This information is processed in particular for the following purposes:
            <ul className="list-disc pl-6 mt-2 space-y-1">
              <li>Ensuring a problem-free connection to the website,</li>
              <li>Ensuring the smooth use of our website,</li>
              <li>Evaluating system security and stability, and</li>
              <li>for other administrative purposes.</li>
            </ul>
          </p>

          <h2 className="text-xl font-bold text-on-surface mt-8 mb-4">2. Registration on our website (Discord Login)</h2>
          <p>
            When registering to use our personalized services (via Discord OAuth), some personal data will be collected, such as your Discord username, your email address, and your Discord user ID. If you are registered with us, you can access content and services that we only offer to registered users.
          </p>

          <h2 className="text-xl font-bold text-on-surface mt-8 mb-4">3. Game statistics and leaderboards</h2>
          <p>
            This platform collects, stores, and processes performance data from games (e.g., Kills, Elo, Rank) to generate leaderboards and user profiles. This data is generally publicly viewable unless stated otherwise in the settings.
          </p>

          <h2 className="text-xl font-bold text-on-surface mt-8 mb-4">4. Your rights to information, correction, blocking, deletion, and objection</h2>
          <p>
            You have the right to receive information about your personal data stored by us at any time. You also have the right to correction, blocking, or, apart from the prescribed data storage for business processing, deletion of your personal data.
          </p>

          <p className="text-sm mt-8 border-t border-zinc-700 pt-4 text-zinc-500">
            <em>Notice: This is a standard template. Please verify it to ensure compliance with local regulations.</em>
          </p>
        </div>
      </div>
    </main>
  );
}
