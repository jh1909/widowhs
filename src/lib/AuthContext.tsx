import React, { createContext, useContext, useState, useEffect } from "react";
import { supabase } from "./supabase";

export type User = {
  id: string;
  username: string;
  discriminator?: string;
  avatar_url?: string;
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
    const ensurePlayerExists = async (username: string) => {
      try {
        // 1. Check if the player already exists in the database
        const { data, error: selectError } = await supabase
          .from('players')
          .select('name')
          .ilike('name', username)
          .maybeSingle();

        if (selectError && selectError.code !== 'PGRST116') {
          console.error("Error checking player existence:", selectError);
          return;
        }

        // 2. If no data exists, insert a new placeholder profile
        if (!data) {
          const { error: insertError } = await supabase.from('players').insert([{
            name: username,
            matches: 0,
            winrate: "-",
            hs: "-",
            elo: "-",
            rank: 999999
          }]);

          // Ignore duplicate constraint failures (HTTP 409, code 23505) gracefully
          if (insertError && insertError.code !== '23505') {
            console.error("Error inserting player:", insertError);
          }
        }
      } catch (err) {
        console.error("Unexpected error ensuring player exists:", err);
      }
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        const username = session.user.user_metadata?.full_name || session.user.user_metadata?.name || 'User';
        setUser({
          id: session.user.id,
          username: username,
          avatar_url: session.user.user_metadata?.avatar_url
        });
        
        ensurePlayerExists(username);
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        const username = session.user.user_metadata?.full_name || session.user.user_metadata?.name || 'User';
        setUser({
          id: session.user.id,
          username: username,
          avatar_url: session.user.user_metadata?.avatar_url
        });

        ensurePlayerExists(username);
      } else {
        setUser(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const login = async () => {
    // Determine the redirect URL dynamically to support deployment properly
    const redirectTo = `${window.location.origin}${window.location.pathname}`;
    
    await supabase.auth.signInWithOAuth({
      provider: 'discord',
      options: {
        redirectTo
      }
    });
  };

  const logout = async () => {
    await supabase.auth.signOut();
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

