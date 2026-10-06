import { Link, NavLink } from "react-router-dom";
import { Crosshair, LogOut, UserRound, Shield } from "lucide-react";
import { useAuth } from "../lib/AuthContext";
import PlayerAvatar from "./PlayerAvatar";

export default function Navigation() {
  const { user, login, logout } = useAuth();
  const isAdmin = user?.isAdmin || user?.username.toLowerCase() === "notprx";
  const navClass = ({ isActive }: { isActive: boolean }) => `nav-link${isActive ? " is-active" : ""}`;
  const profilePath = `/profile/${user ? user.username.toLowerCase() : "me"}`;
  return (
    <header className="site-header">
      <div className="nav-shell">
        <Link to="/" className="brand" aria-label="WIDOW HS home">
          <span className="brand-mark"><Crosshair size={22} strokeWidth={1.7} /></span>
          <span>WIDOW<span className="text-toxic-purple"> HS.</span></span>
        </Link>
        <nav aria-label="Main navigation" className="desktop-nav">
          <NavLink to="/" end className={navClass}>Leaderboard</NavLink>
          <NavLink to={profilePath} className={navClass}>My profile</NavLink>
          {isAdmin && <NavLink to="/admin" className={navClass}><Shield size={14} /> Admin</NavLink>}
        </nav>
        {user ? (
          <div className="flex items-center gap-3 min-w-0">
            <Link to={profilePath} className="account-link">
              <PlayerAvatar name={user.username} avatarUrl={user.avatar_url} className="w-8 h-8 rounded-lg border border-toxic-purple/20 bg-toxic-purple/10 text-xs" /><span className="hidden sm:inline truncate max-w-36">{user.username}</span>
            </Link>
            <button onClick={logout} className="icon-button" aria-label="Log out"><LogOut size={17} /></button>
          </div>
        ) : (
          <button onClick={login} className="button-primary nav-login"><UserRound size={16} /> Sign in with Discord</button>
        )}
      </div>
      <nav aria-label="Mobile navigation" className="mobile-nav">
        <NavLink to="/" end className={navClass}>Leaderboard</NavLink>
        <NavLink to={profilePath} className={navClass}>My profile</NavLink>
        {isAdmin && <NavLink to="/admin" className={navClass}>Admin</NavLink>}
      </nav>
    </header>
  );
}
