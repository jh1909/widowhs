import { HashRouter as Router, Routes, Route, Link, Navigate } from "react-router-dom";
import Leaderboard from "./pages/Leaderboard";
import Profile from "./pages/Profile";
import Admin from "./pages/Admin";
import PrivacyPolicy from "./pages/PrivacyPolicy";
import Imprint from "./pages/Imprint";
import Navigation from "./components/Navigation";
import { AuthProvider } from "./lib/AuthContext";

export default function App() {
  return (
    <Router>
      <AuthProvider>
        <div className="flex flex-col min-h-screen bg-background text-on-background selection:bg-toxic-purple/30 selection:text-primary">
          <Routes>
            <Route path="/admin/*" element={<Admin />} />
            <Route
              path="*"
              element={
                <>
                  <Navigation />
                  <Routes>
                    <Route path="/" element={<Leaderboard />} />
                    <Route path="/profile/:id" element={<Profile />} />
                    <Route path="/privacy" element={<PrivacyPolicy />} />
                    <Route path="/imprint" element={<Imprint />} />
                    <Route path="/terms" element={<Navigate to="/" replace />} />
                  </Routes>
                  <Footer />
                </>
              }
            />
          </Routes>
        </div>
      </AuthProvider>
    </Router>
  );
}

function Footer() {
  return (
    <footer className="site-footer mt-auto">
      <div className="footer-shell">
        <div><span className="font-bold text-zinc-400">WIDOW HS.</span><span className="ml-3">© 2026 · Made for the community.</span></div>
        <nav className="footer-links" aria-label="Legal and community">
          <a href="https://discord.gg/PKYGBFV" target="_blank" rel="noopener noreferrer">Discord</a>
          <Link to="/imprint">Impressum</Link>
          <Link to="/privacy">Datenschutz</Link>
        </nav>
      </div>
    </footer>
  );
}
