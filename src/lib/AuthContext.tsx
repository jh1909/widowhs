import React, { createContext, useContext, useState, useEffect } from "react";

export type User = {
  id: string;
  username: string;
  discriminator: string;
};

type AuthContextType = {
  user: User | null;
  login: () => void;
  logout: () => void;
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    // Check if there's a user in localStorage
    const storedUser = localStorage.getItem("auth_user");
    if (storedUser) {
      try {
        setUser(JSON.parse(storedUser));
      } catch (e) {
        // ignore
      }
    }

    // Listen for the OAUTH_AUTH_SUCCESS message from popup
    const handleMessage = (event: MessageEvent) => {
      // Strict origin check for production
      if (event.origin !== window.location.origin) {
        return;
      }
      
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS' && event.data.user) {
        const u = event.data.user;
        setUser(u);
        localStorage.setItem("auth_user", JSON.stringify(u));
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const login = async () => {
    try {
      const res = await fetch("/api/auth/discord/url");
      
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || "Failed to initialize Discord Login. Check environment variables.");
        return;
      }

      const data = await res.json();
      if (data.url) {
        window.open(data.url, 'oauth_popup', 'width=600,height=700');
      }
    } catch (e) {
      console.error("Login failed", e);
      alert("Failed to connect to authentication server.");
    }
  };

  const logout = () => {
    setUser(null);
    localStorage.removeItem("auth_user");
  };

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
