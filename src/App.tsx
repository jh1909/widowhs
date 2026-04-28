import { HashRouter as Router, Routes, Route, Link } from "react-router-dom";
import Leaderboard from "./pages/Leaderboard";
import Profile from "./pages/Profile";
import Admin from "./pages/Admin";
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
    <footer className="bg-[#09090b] text-toxic-purple font-mono text-[10px] text-zinc-500 uppercase tracking-widest w-full border-t border-toxic-purple/10 flex flex-col md:flex-row justify-between items-center px-8 py-6 mt-auto">
      <div>© 2026 WIDOW HS. PROTOCOL V.2.0.4</div>
      <div className="flex gap-4 mt-4 md:mt-0 underline-offset-4">
        <Link className="text-zinc-600 hover:text-toxic-purple hover:underline transition-colors" to="#">Privacy Policy</Link>
        <Link className="text-zinc-600 hover:text-toxic-purple hover:underline transition-colors" to="#">Terms of Service</Link>
        <Link className="text-zinc-600 hover:text-toxic-purple hover:underline transition-colors" to="#">GDPR Compliance</Link>
        <Link className="text-zinc-600 hover:text-toxic-purple hover:underline transition-colors" to="#">API Documentation</Link>
      </div>
    </footer>
  );
}
