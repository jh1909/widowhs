import React, { createContext, useContext, useState, useEffect } from "react";
import { supabase } from "./supabase";

export type User = {
  id: string;
  username: string;
  discriminator?: string;
  avatar_url?: string;
  isAdmin?: boolean;
};

type AuthContextType = {
  user: User | null;
  login: () => void;
  logout: () => void;
  setUser: React.Dispatch<React.SetStateAction<User | null>>;
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profileSyncVersion, setProfileSyncVersion] = useState(0);
  const profileReady = React.useRef<string | null>(null);

  useEffect(() => {
    // INITIAL_SESSION also restores an existing login. Keep this callback
    // synchronous; profile RPCs must run after Supabase releases its auth lock.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        const username =
          session.user.user_metadata?.full_name ||
          session.user.user_metadata?.name ||
          "User";
        setUser((prev) => {
          if (prev && prev.id === session.user.id) return prev;
          return {
            id: session.user.id,
            username: username,
            avatar_url: session.user.user_metadata?.avatar_url,
          };
        });
        // A later auth event retries a failed profile request without running
        // an RPC inside this callback or refetching an already loaded profile.
        if (profileReady.current !== session.user.id) setProfileSyncVersion(version => version + 1);
      } else {
        profileReady.current = null;
        setUser(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const userId = user?.id;
  const avatarUrl = user?.avatar_url;
  // A nickname edit must not reinitialize the Discord profile.
  const discordName = React.useRef(user?.username);
  discordName.current = user?.username;
  useEffect(() => {
    if (!userId) return;
    let active = true;
    profileReady.current = null;
    const loadProfile = async () => {
      try {
        const { data, error } = await supabase.rpc("ensure_discord_player", {
          p_name: discordName.current ?? "User", p_avatar_url: avatarUrl ?? null,
        });
        if (!active) return;
        if (error) throw error;
        profileReady.current = userId;
        if (data?.name) setUser(previous => previous?.id === userId
          ? { ...previous, username: data.name, isAdmin: !!data.is_admin } : previous);
      } catch (error) {
        if (active) console.error("Could not load your Discord profile", error);
      }
    };
    void loadProfile();
    return () => { active = false; };
  }, [userId, avatarUrl, profileSyncVersion]);

  const login = async () => {
    // Determine the redirect URL dynamically to support deployment properly
    const redirectTo = `${window.location.origin}${window.location.pathname}`;

    await supabase.auth.signInWithOAuth({
      provider: "discord",
      options: {
        redirectTo,
      },
    });
  };

  const logout = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, login, logout, setUser }}>
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
