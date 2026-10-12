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

  useEffect(() => {
    let ensuredUserId: string | null = null;
    const ensurePlayerExists = async (discordName: string, userId: string, avatarUrl?: string) => {
      if (ensuredUserId === userId) return;
      ensuredUserId = userId;
      const { data, error } = await supabase.rpc("ensure_discord_player", {
        p_name: discordName, p_avatar_url: avatarUrl ?? null,
      });
      if (error) {
        ensuredUserId = null;
        console.error("Could not load your Discord profile", error);
        return;
      }
      if (data?.name) setUser(previous => previous?.id === userId
        ? { ...previous, username: data.name, isAdmin: !!data.is_admin } : previous);
    };
    supabase.auth.getSession().then(({ data: { session } }) => {
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

        ensurePlayerExists(
          username,
          session.user.id,
          session.user.user_metadata?.avatar_url,
        );
      }
    });

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

        ensurePlayerExists(
          username,
          session.user.id,
          session.user.user_metadata?.avatar_url,
        );
      } else {
        ensuredUserId = null;
        setUser(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

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
